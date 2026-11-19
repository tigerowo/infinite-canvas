#!/usr/bin/env node
import express from "express";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexClient } from "./codex.mjs";

const entry = fileURLToPath(import.meta.url);
const configPath = resolve(homedir(), ".infinite-canvas", "codex-agent.json");
const readConfig = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const savedConfig = readConfig();
const serviceId = savedConfig?.serviceId || randomUUID();
const mode = process.argv[2];
if (!savedConfig && ["config", "open"].includes(mode)) throw new Error("请先启动本地 Canvas Agent 服务");
const token = process.env.CANVAS_AGENT_TOKEN || savedConfig?.token || (mode === "mcp" ? "" : randomBytes(32).toString("hex"));
if (mode !== "mcp" && (typeof token !== "string" || token.length < 32)) throw new Error("本地连接 Token 至少需要 32 位字符");
const port = Number(process.env.CANVAS_AGENT_PORT || savedConfig?.port || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地服务端口无效");
const endpoint = "http://127.0.0.1:" + port;
const workspace = dirname(entry);
const origins = new Set(process.env.CANVAS_AGENT_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) || savedConfig?.origins || []);
const sessions = new Map();
const methods = new Set(["model/list", "thread/start", "thread/resume", "thread/archive", "turn/start", "turn/interrupt", "bridge/stop"]);

const videoTool = {
    name: "extract_video_frames",
    description: "读取当前画布视频节点的画面供你分析。首次调用必须传 newAnalysis: true 且不传 analysisId；后续续取和补查必须传回返回的 analysisId。同一任务总计最多 20 分钟。默认每 1 秒取一帧，需看表情、构图、字幕或短动作时传 detailed: true，每 0.5 秒取一帧。每次最多 90 张，nextStartMs 非空时从该位置继续。按帧的时间戳回答用户。",
    inputSchema: {
        type: "object",
        properties: {
            nodeId: { type: "string" }, analysisId: { type: "string" }, newAnalysis: { type: "boolean" }, detailed: { type: "boolean" }, startMs: { type: "number", minimum: 0 }, endMs: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["nodeId"],
    },
};
const videoAnalysisTimeoutMs = 20 * 60_000;

async function openCanvas() {
    const target = URL.canParse(process.argv[3] || "") ? new URL(process.argv[3]) : null;
    if (!target || !["http:", "https:"].includes(target.protocol) || target.username || target.password || !/^\/canvas\/[^/]+\/?$/.test(target.pathname)) throw new Error("请提供实际画布的 HTTP(S) 地址");
    const browser = process.argv[4];
    if (!["chrome", "edge", "firefox", "brave", "default"].includes(browser)) throw new Error("请指定原画布浏览器：chrome、edge、firefox、brave 或 default");
    const params = new URLSearchParams(target.hash.slice(1));
    params.set("agentUrl", endpoint);
    params.set("agentToken", token);
    target.hash = params.toString();
    const { default: open, apps } = await import("open");
    try {
        await open(target.href, { app: { name: browser === "default" ? apps.browser : apps[browser], arguments: process.argv.slice(5) } });
    } catch (error) {
        throw new Error("打开浏览器失败，请检查原浏览器、配置和启动权限" + (error.code ? "：" + error.code : ""));
    }
    console.log("已请求浏览器打开原画布，等待 MCP 确认连接");
}

function saveConfig() {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ url: endpoint, port, token, serviceId, origins: [...origins] }, null, 2) + "\n", { mode: 0o600 });
}

function findSession(clientId) {
    if (!clientId) {
        const connected = [...sessions.values()].filter((session) => session.events && session.canvasId);
        if (connected.length !== 1) throw new Error("请只连接一个画布，或为 MCP 设置 CANVAS_AGENT_CLIENT_ID");
        return connected[0];
    }
    const session = sessions.get(clientId);
    if (!session) throw new Error("画布尚未连接");
    return session;
}

function emit(session, event, data) {
    session.events?.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

function closeSession(session) {
    if (sessions.get(session.clientId) === session) sessions.delete(session.clientId);
    for (const pending of session.toolsPending.values()) {
        clearTimeout(pending.timer);
        pending.videoController?.abort();
        pending.reject(new Error("画布已断开，工具未完成"));
    }
    session.toolsPending.clear();
    session.videoAnalyses.clear();
    const events = session.events;
    session.events = undefined;
    session.codex?.close();
    events?.end();
}

function callTool(session, name, args, source, generation, res) {
    if (!session.events || !session.tools.some((tool) => tool.name === name)) throw new Error("画布未连接或工具不存在");
    if (source === "codex" && (generation !== session.codexGeneration || !session.codex || session.codex.stopped)) throw new Error("Codex 请求已停止");
    if (res.destroyed) throw new Error("画布工具请求已取消");
    let video;
    let timeout = 90_000;
    if (name === videoTool.name) {
        const input = args ?? {};
        const analysisId = typeof input.analysisId === "string" ? input.analysisId : "";
        if (typeof input.nodeId !== "string" || !input.nodeId) throw new Error("缺少视频节点标识");
        if (input.newAnalysis === true && analysisId) throw new Error("新的视频分析任务不能传 analysisId");
        if (input.newAnalysis !== true && !analysisId) throw new Error("首次调用请传 newAnalysis: true，后续调用请传 analysisId");
        video = { ...input };
        if (input.newAnalysis === true) {
            video.analysisId = randomUUID();
            session.videoAnalyses.set(video.analysisId, { nodeId: input.nodeId, deadline: Date.now() + videoAnalysisTimeoutMs });
            timeout = videoAnalysisTimeoutMs;
        } else {
            const analysis = session.videoAnalyses.get(analysisId);
            if (!analysis || analysis.nodeId !== input.nodeId) throw new Error("视频分析任务不存在");
            timeout = analysis.deadline - Date.now();
            if (timeout <= 0) {
                session.videoAnalyses.delete(analysisId);
                throw new Error("视频分析总计已超过 20 分钟");
            }
        }
    }
    const requestId = randomUUID();
    const cancel = (message) => {
        const pending = session.toolsPending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        emit(session, "tool-cancel", { requestId });
        pending.videoController?.abort();
        pending.reject(new Error(message));
    };
    const onClose = () => { if (!res.writableEnded) cancel("画布工具请求已取消"); };
    res.once("close", onClose);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel(video ? "视频分析总计已超过 20 分钟" : "画布工具执行超时"), timeout);
        const videoController = video ? new AbortController() : undefined;
        session.toolsPending.set(requestId, { resolve, reject, timer, source, cancel, video, videoController });
        emit(session, "tool", { requestId, name, arguments: video ?? args, source, generation });
    }).finally(() => res.off("close", onClose));
}

async function runRpc(session, method, params = {}, generation) {
    if (!methods.has(method)) throw new Error("不支持的 Codex 方法");
    if (!session.events || !session.canvasId) throw new Error("请先连接画布并注册工具");
    if (!Number.isSafeInteger(generation) || generation < session.codexGeneration) throw new Error("Codex 请求已停止");
    if (generation > session.codexGeneration) {
        session.codexGeneration = generation;
        session.codex?.close();
    }
    if (method === "bridge/stop") return { ok: true };
    if (!session.codex || session.codex.stopped) session.codex = new CodexClient((event, data) => {
        if (data.method === "bridge/disconnected") {
            if (generation === session.codexGeneration) session.codexGeneration += 1;
            for (const pending of session.toolsPending.values()) if (pending.source === "codex") pending.cancel("Codex 请求已停止");
        }
        emit(session, event, { ...data, generation });
    });
    const codex = session.codex;
    await codex.ready;
    if (method === "thread/start" || method === "thread/resume") {
        params = {
            ...params,
            cwd: workspace,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            config: { mcp_servers: { "infinite-canvas": {
                command: process.execPath,
                args: [entry, "mcp"],
                default_tools_approval_mode: "approve",
                env: { CANVAS_AGENT_TOKEN: token, CANVAS_AGENT_PORT: String(port), CANVAS_AGENT_CLIENT_ID: session.clientId, CANVAS_AGENT_SOURCE: "codex", CANVAS_AGENT_CODEX_GENERATION: String(generation) },
                startup_timeout_sec: 20,
                tool_timeout_sec: 300,
            } } },
        };
    }
    if (method === "turn/start") {
        params = { ...params, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } };
    }
    return codex.request(method, params);
}

const assets = {
    "linux/x64": ["linux-x64", 3241368, "833f720dc27bd992edea8a377b4c8ceeff8f3fe966953a53c433b4e072454685"],
    "linux/arm64": ["linux-arm64", 2636688, "c7c73a0def478aafe37b120b2a091539a29f538c8539fadd484a5bf59d2b485c"],
    "win32/x64": ["windows-x64.exe", 2641920, "e9e5b6e2afd96b11b291139d0b60d077bdddcb64f218610a6ffeeb82c6ed0203"],
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const run = promisify(execFile);
const maxFrames = 90;
const maxFrameBytes = 512 * 1024;

async function prepareFFmpeg(signal) {
    const asset = assets[process.platform + "/" + process.arch];
    if (!asset) throw new Error("精简 FFmpeg 暂不支持当前系统和架构");
    const [suffix, size, digest] = asset;
    const name = "ffmpeg-6.1.4-" + suffix;
    const cache = process.platform === "win32"
        ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
        : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    const directory = join(cache, "infinite-canvas", "ffmpeg");
    const target = join(directory, name);
    const info = await stat(target).catch(() => null);
    if (!(info?.isFile() && info.size === size && sha256(await readFile(target)) === digest)) {
        const response = await fetch("https://github.com/tigerowo/infinite-canvas/releases/download/v0.8.4/" + name, { signal });
        if (!response.ok) throw new Error("下载精简 FFmpeg 失败，HTTP " + response.status);
        const binary = Buffer.from(await response.arrayBuffer());
        if (binary.length !== size || sha256(binary) !== digest) throw new Error("精简 FFmpeg 校验失败");
        await mkdir(directory, { recursive: true });
        const temporary = target + "." + randomUUID();
        try {
            await writeFile(temporary, binary, { flag: "wx", mode: 0o700, signal });
            await rename(temporary, target).catch(async (error) => {
                const installed = await readFile(target).catch(() => null);
                if (!installed || sha256(installed) !== digest) throw error;
            });
        } finally {
            await rm(temporary, { force: true });
        }
    }
    if (process.platform !== "win32") await chmod(target, 0o700);
    return target;
}

async function readVideoFrames(upload, { startMs = 0, endMs, detailed, analysisId }, signal, acknowledge) {
    const startUs = Math.round(startMs * 1000);
    const endUs = endMs === undefined ? null : Math.round(endMs * 1000);
    if (typeof startMs !== "number" || !Number.isSafeInteger(startUs) || startUs < 0 ||
        (endUs !== null && (typeof endMs !== "number" || !Number.isSafeInteger(endUs) || endUs <= startUs))) {
        throw new Error("视频取帧区间无效");
    }
    const fromUrl = typeof upload === "string";
    const directory = await mkdtemp(join(tmpdir(), "canvas-video-"));
    try {
        if (fromUrl) {
            const url = new URL(upload);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("视频地址无效");
            signal.throwIfAborted();
            acknowledge();
            const response = await fetch(url, { signal });
            if (response.status !== 200 || !response.body) {
                await response.body?.cancel();
                throw new Error("本机下载视频失败，HTTP " + response.status);
            }
            upload = response.body;
        }
        const input = join(directory, "video");
        const writer = createWriteStream(input);
        await pipeline(upload, writer, { signal });
        if (writer.bytesWritten === 0) throw new Error("原视频为空");
        signal.throwIfAborted();
        if (!fromUrl) acknowledge();
        const ffmpeg = await prepareFFmpeg(signal);
        const gap = detailed === true ? 500_000 : 1_000_000;
        const select = `if(isnan(prev_selected_pts),1,gt(floor((pts-${startUs})/${gap}),floor((prev_selected_pts-${startUs})/${gap})))`;
        const trim = "trim=start=" + startUs + "us" + (endUs === null ? "" : ":end=" + endUs + "us");
        const filter = "settb=AVTB," + trim + ",select='" + select + "',trim=end_frame=" + (maxFrames + 1)
            + ",scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p,showinfo=checksum=0";
        const extraction = run(ffmpeg, [
            "-hide_banner", "-nostdin", "-nostats", "-xerror", "-copyts", "-start_at_zero",
            "-protocol_whitelist", "file", "-format_whitelist", "mov", "-threads", "2",
            "-ss", startUs + "us", "-i", input, "-map", "0:V:0", "-an", "-sn", "-dn",
            "-filter_threads", "1", "-vf", filter, "-fps_mode", "passthrough",
            "-c:v", "mjpeg", "-threads", "2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "canvas_frame", "pipe:1",
        ], { encoding: "buffer", signal, windowsHide: true, maxBuffer: (maxFrames + 1) * (maxFrameBytes + 128) });
        const closed = new Promise((resolve) => extraction.child.once("close", resolve));
        const { stdout, stderr } = await extraction.catch(async (error) => {
            await closed;
            signal.throwIfAborted();
            throw new Error("精简 FFmpeg 无法抽取该视频的画面", { cause: error });
        });

        const times = [...stderr.toString().matchAll(/^\[Parsed_showinfo_\d+ @ [^\]]+\]\s+n:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/gm)]
            .map((match) => Number(match[1]) / 1000);
        if (!times.length) throw new Error("所选区间没有可分析的视频帧");
        const nextFrameMs = times[maxFrames];
        const nextStartMs = nextFrameMs === undefined ? null
            : (startUs + Math.floor((Math.round(nextFrameMs * 1000) - startUs) / gap) * gap) / 1000;
        const content = [{ type: "text", text: JSON.stringify({ analysisId, nextStartMs }) }];
        const seen = new Map();
        const boundary = Buffer.from("--canvas_frame\r\n");
        let offset = 0;
        for (const [index, time] of times.entries()) {
            if (!stdout.subarray(offset, offset + boundary.length).equals(boundary)) throw new Error("FFmpeg 图片输出异常");
            const header = offset + boundary.length;
            const start = stdout.indexOf("\r\n\r\n", header) + 4;
            const bytes = Number(/^Content-type: image\/jpeg\r\nContent-length: (\d+)$/.exec(stdout.toString("ascii", header, start - 4))?.[1]);
            offset = start + bytes + 2;
            if (!Number.isSafeInteger(bytes) || bytes < 4 || bytes > maxFrameBytes ||
                stdout[offset - 2] !== 13 || stdout[offset - 1] !== 10) throw new Error("FFmpeg 图片输出异常");
            if (index === maxFrames) break;
            const image = stdout.subarray(start, start + bytes);
            const digest = sha256(image);
            const previous = seen.get(digest);
            content.push({ type: "text", text: previous === undefined ? "视频时间 " + time + " 毫秒" : time + " 毫秒与 " + previous + " 毫秒画面相同" });
            if (previous !== undefined) continue;
            seen.set(digest, time);
            content.push({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") });
        }
        if (!stdout.subarray(offset).equals(boundary)) throw new Error("视频帧与时间戳不匹配");
        return content;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function startMcp() {
    const clientId = process.env.CANVAS_AGENT_CLIENT_ID || "";
    const source = process.env.CANVAS_AGENT_SOURCE === "codex" ? "codex" : "external";
    const generation = Number(process.env.CANVAS_AGENT_CODEX_GENERATION || 0);
    async function request(path, body, signal) {
        const config = readConfig();
        const requestToken = process.env.CANVAS_AGENT_TOKEN || config?.token;
        if (!requestToken) throw new Error("请先启动本地 Canvas Agent 服务");
        const url = "http://127.0.0.1:" + (process.env.CANVAS_AGENT_PORT || config?.port || 3210);
        const timeout = body?.name === videoTool.name ? videoAnalysisTimeoutMs + 5_000 : 95_000;
        const response = await fetch(url + path, {
            method: body ? "POST" : "GET",
            headers: { "Content-Type": "application/json", "x-canvas-agent-token": requestToken },
            body: body ? JSON.stringify({ ...body, clientId, source, generation }) : undefined,
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        });
        const value = await response.json();
        if (!response.ok || (body?.name === videoTool.name && typeof value?.error === "string")) throw new Error(value.error || "画布连接失败");
        return value;
    }
    const server = new Server({ name: "infinite-canvas", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
    const toolsPath = "/tools?clientId=" + encodeURIComponent(clientId);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        try {
            const tools = await request(toolsPath);
            return { tools: source === "codex" ? tools : tools.filter(({ name }) => name !== "set_agent_state" && name !== "read_skill_file") };
        } catch { return { tools: [] }; }
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        try {
            const result = await request("/tools/call", { name: params.name, arguments: params.arguments || {} }, signal);
            if (params.name === videoTool.name) return result;
            return { isError: result?.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error.message }] };
        }
    });
    let retry;
    let closed = false;
    async function announceTools() {
        try {
            const tools = await request(toolsPath);
            if (!tools.length) throw new Error("等待画布连接");
            if (!closed) await server.notification({ method: "notifications/tools/list_changed" });
        } catch {
            if (!closed) retry = setTimeout(announceTools, 2000);
        }
    }
    server.oninitialized = () => { void announceTools(); };
    server.onclose = () => { closed = true; clearTimeout(retry); };
    await server.connect(new StdioServerTransport());
}

function startHttp() {
    const app = express();
    app.use((req, res, next) => {
        if (!["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host)) return res.status(403).json({ error: "无效的本地地址" });
        const origin = req.headers.origin;
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-canvas-agent-token");
            res.setHeader("Access-Control-Expose-Headers", "x-canvas-agent-generation");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        if (req.method === "GET" && req.path === "/config") return res.json({ url: endpoint, hasToken: Boolean(token) });
        const credential = req.path === "/events" ? req.query.token : req.headers["x-canvas-agent-token"];
        if (credential !== token) return res.status(401).json({ error: "Token 不正确" });
        if (origin && !origins.has(origin)) {
            origins.add(origin);
            saveConfig();
        }
        next();
    });
    app.use(express.json({ limit: "20mb" }));
    app.post("/connect", (req, res) => {
        const { clientId, canvasId, tools, videoMedia } = req.body;
        if (typeof clientId !== "string" || !clientId || typeof canvasId !== "string" || !canvasId || !Array.isArray(tools)) {
            return res.status(400).json({ error: "连接参数不完整" });
        }
        const session = findSession(clientId);
        if ((session.canvasId && session.canvasId !== canvasId) || session.origin !== req.headers.origin) {
            return res.status(409).json({ error: "连接标识已被其他画布使用" });
        }
        session.canvasId = canvasId;
        session.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        if (videoMedia === true) session.tools.push(videoTool);
        res.json({ serviceId });
    });
    app.get("/events", (req, res) => {
        const clientId = req.query.clientId;
        if (typeof clientId !== "string" || !clientId) return res.status(400).json({ error: "缺少连接标识" });
        let session = sessions.get(clientId);
        if (!session) {
            session = { clientId, origin: req.headers.origin, tools: [], toolsPending: new Map(), videoAnalyses: new Map(), codexGeneration: 0 };
            sessions.set(clientId, session);
        }
        if (session.origin !== req.headers.origin) return res.status(403).json({ error: "连接来源不匹配" });
        const previous = session.events;
        session.events = res;
        previous?.end();
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(": connected\n\n");
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => {
            clearInterval(heartbeat);
            if (session.events === res) closeSession(session);
        });
    });
    app.post("/rpc", async (req, res) => {
        const { clientId, method, params, generation } = req.body;
        const session = findSession(clientId);
        res.json(await runRpc(session, method, params, generation).finally(() => res.setHeader("x-canvas-agent-generation", String(session.codexGeneration))));
    });
    app.post("/reply", (req, res) => {
        const { clientId, id, result, error, generation } = req.body;
        const session = findSession(clientId);
        if (generation === session.codexGeneration) session.codex?.reply(id, result, error);
        res.json({ ok: true });
    });
    app.post("/result", async (req, res) => {
        const binary = req.is("application/octet-stream");
        const videoUrl = req.body?.videoUrl;
        if (binary || typeof videoUrl === "string") {
            const { clientId, requestId } = binary ? req.query : req.body;
            const session = sessions.get(clientId);
            const pending = session?.toolsPending.get(requestId);
            if (!pending?.video || pending.receivingVideo || session.origin !== req.headers.origin) {
                return res.status(409).json({ error: "视频请求已结束" });
            }
            pending.receivingVideo = true;
            const controller = pending.videoController;
            const acknowledge = () => {
                if (!res.destroyed && !res.writableEnded) res.json({ ok: true });
            };
            res.once("close", () => {
                if (!res.writableEnded) controller.abort();
            });
            try {
                const content = await readVideoFrames(binary ? req : videoUrl, pending.video, controller.signal, acknowledge);
                pending.resolve({ content });
            } catch (error) {
                pending.reject(error);
            } finally {
                clearTimeout(pending.timer);
                session.toolsPending.delete(requestId);
            }
            acknowledge();
            return;
        }
        const { clientId, requestId, result, error } = req.body;
        const session = findSession(clientId);
        const pending = session.toolsPending.get(requestId);
        if (!pending || (pending.video && !error)) return res.status(409).json({ error: "工具请求已结束" });
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        if (error) {
            pending.videoController?.abort();
            pending.reject(new Error(error));
        } else pending.resolve(result);
        res.json({ ok: true });
    });
    app.get("/tools", (req, res) => {
        const session = findSession(req.query.clientId);
        if (!session.canvasId) throw new Error("请先在网页连接画布");
        res.json(session.tools);
    });
    app.post("/tools/call", async (req, res) => {
        const { clientId, name, arguments: args, source, generation } = req.body;
        const session = findSession(clientId);
        if (name !== videoTool.name) return res.json(await callTool(session, name, args, source === "codex" ? "codex" : "external", generation, res));
        res.type("application/json");
        res.write(" ");
        const heartbeat = setInterval(() => res.write(" "), 15000);
        try {
            res.end(JSON.stringify(await callTool(session, name, args, source === "codex" ? "codex" : "external", generation, res)));
        } catch (error) {
            if (!res.destroyed) res.end(JSON.stringify({ error: error.message }));
        } finally {
            clearInterval(heartbeat);
        }
    });
    app.use((error, req, res, next) => {
        if (res.destroyed) return;
        if (res.headersSent) return next(error);
        res.status(400).json({ error: error.message });
    });
    const server = app.listen(port, "127.0.0.1", () => {
        saveConfig();
        console.log("Local URL: " + endpoint);
        console.log("Connect token: " + token);
    });
    server.on("error", (error) => {
        console.error("Canvas Agent 启动失败：" + error.message);
        process.exitCode = 1;
    });
    function shutdown() {
        for (const session of sessions.values()) closeSession(session);
        server.close();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (mode === "config") console.log(JSON.stringify({ url: endpoint, token, origins: [...origins] }));
else if (mode === "open") await openCanvas();
else if (mode === "mcp") await startMcp();
else startHttp();
