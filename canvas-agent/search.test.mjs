import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        assert(Date.now() < deadline, "Timed out waiting for the agent");
        await delay();
    }
}
async function listen(server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
}
async function readBody(request) {
    let body = "";
    for await (const chunk of request) body += chunk;
    return body ? JSON.parse(body) : {};
}

// Real Codex app-server and HTTP MCP transport; only model inference and the
// remote service are fixtures. The proxy observes the production destination,
// headers and tool arguments without a search key or an external network call.
await test("Canvas Agent search", { timeout: 120000 }, async (suite) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-agent-search-"));
    suite.after(() => rm(root, { recursive: true, force: true }));
    const openssl = (...args) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Canvas Agent Test CA");
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "leaf.csr", "-subj", "/CN=search.parallel.ai");
    await writeFile(join(root, "ext.cnf"), "subjectAltName=DNS:search.parallel.ai\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-out", "cert.pem", "-days", "2", "-extfile", "ext.cnf");

    async function fixture(t, { saved = "", overrides, steps = [], failure } = {}) {
        const requests = [], models = [], events = [], connections = [], sockets = new Set();
        const queue = [...steps];
        const track = (server) => {
            server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
            t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
            return server;
        };
        const mcp = track(https.createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, async (req, res) => {
            const body = await readBody(req);
            requests.push({ path: req.url, headers: req.headers, body });
            if (req.method === "GET") return res.writeHead(405).end();
            if (body.id === undefined) return res.writeHead(202).end();
            let result;
            if (body.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "search-fixture", version: "1" } };
            else if (body.method === "tools/list") result = { tools: [
                { name: "web_search", description: "Search references", inputSchema: { type: "object", properties: { objective: { type: "string" }, search_queries: { type: "array", items: { type: "string" } } }, required: ["objective", "search_queries"] }, annotations: { readOnlyHint: true } },
                { name: "web_fetch", description: "Read source pages", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"] }, annotations: { readOnlyHint: true } },
            ] };
            else if (body.method === "tools/call") {
                if (failure === "hang") return;
                if (failure === "http") return res.writeHead(503).end("Search unavailable");
                result = failure === "tool" ? { isError: true, content: [{ type: "text", text: "Search unavailable" }] }
                    : { content: [{ type: "text", text: body.params.name === "web_search" ? "reference https://example.com/canvas?q=art#source" : "page: canvas reference material" }] };
            } else result = {};
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        }));
        const mcpPort = await listen(mcp);
        const proxy = track(http.createServer());
        proxy.on("connect", (req, socket, head) => {
            // Block Codex's unrelated background catalog traffic as well.
            if (req.url !== "search.parallel.ai:443") return socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            connections.push(req.url);
            const tunnel = net.connect(mcpPort, "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) tunnel.write(head);
                socket.pipe(tunnel); tunnel.pipe(socket);
            });
            sockets.add(tunnel);
            tunnel.on("close", () => sockets.delete(tunnel));
            socket.on("error", () => tunnel.destroy());
            tunnel.on("error", () => socket.destroy());
        });
        const proxyPort = await listen(proxy);
        const model = track(http.createServer(async (req, res) => {
            if (!req.url.endsWith("/responses")) return res.writeHead(404).end();
            const body = await readBody(req);
            models.push(body);
            const step = queue.shift();
            const namespace = body.tools.find((tool) => tool.name === "mcp__parallel_search");
            const tool = namespace?.tools.find((tool) => tool.name === step);
            const item = tool ? { type: "function_call", namespace: namespace.name, name: tool.name, call_id: "call-" + models.length,
                arguments: JSON.stringify(step === "web_search" ? { objective: "Canvas references", search_queries: ["canvas reference art"] } : { urls: ["https://example.com/canvas?q=art#source"] }) }
                : { type: "message", role: "assistant", id: "message-" + models.length, content: [{ type: "output_text", text: "Canvas research complete." }] };
            const responseId = "response-" + models.length;
            const chunks = [{ type: "response.created", response: { id: responseId } }, { type: "response.output_item.done", item },
                { type: "response.completed", response: { id: responseId, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
            res.writeHead(200, { "Content-Type": "text/event-stream" }).end(chunks.map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""));
        }));
        const modelPort = await listen(model);
        const home = await mkdtemp(join(root, "run-"));
        const codexHome = join(home, "codex");
        await mkdir(codexHome);
        const configuration = 'model = "gpt-5.4"\nmodel_provider = "fixture"\n' + saved + '\n[projects.' + JSON.stringify(dirname(directory)) + ']\ntrust_level = "trusted"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:' + modelPort + '/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n';
        await writeFile(join(codexHome, "config.toml"), configuration);
        const reserve = net.createServer();
        const port = await listen(reserve);
        await new Promise((resolve) => reserve.close(resolve));
        const token = "canvas-agent-test-token-0123456789";
        const agent = spawn(process.execPath, [join(directory, "index.mjs")], {
            // Isolate both stored credentials and ambient API keys.
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, CANVAS_AGENT_PORT: String(port), CANVAS_AGENT_TOKEN: token,
                HTTPS_PROXY: "http://127.0.0.1:" + proxyPort, HTTP_PROXY: "http://127.0.0.1:" + proxyPort, NO_PROXY: "127.0.0.1,localhost", CODEX_CA_CERTIFICATE: join(root, "ca.pem") },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const controller = new AbortController();
        t.after(async () => {
            controller.abort();
            const exit = once(agent, "exit");
            agent.kill("SIGTERM");
            await exit;
        });
        let ready = false;
        agent.stdout.on("data", (data) => { if (data.toString().includes("Local URL:")) ready = true; });
        agent.stderr.resume();
        await until(() => ready);
        const url = "http://127.0.0.1:" + port;
        const stream = await fetch(url + "/events?clientId=test&token=" + token, { signal: controller.signal });
        void (async () => {
            let buffer = "";
            for await (const chunk of stream.body) {
                buffer += Buffer.from(chunk).toString();
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
                    buffer = buffer.slice(end + 2);
                    if (data) events.push(JSON.parse(data.slice(6)));
                }
            }
        })().catch(() => {});
        const post = async (path, body) => {
            const response = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", "x-canvas-agent-token": token }, body: JSON.stringify(body) });
            const result = await response.json();
            assert.equal(response.status, 200, JSON.stringify(result));
            return result;
        };
        await post("/connect", { clientId: "test", canvasId: "canvas", tools: [] });
        const rpc = (method, params = {}) => post("/rpc", { clientId: "test", generation: 0, method, params });
        const started = await rpc("thread/start", overrides ? { config: overrides } : {});
        const threadId = started.thread.id;
        async function turn() {
            const { turn } = await rpc("turn/start", { threadId, input: [{ type: "text", text: "Research canvas references." }] });
            await until(() => events.some((event) => event.method === "turn/completed" && event.params.turn.id === turn.id));
            const completed = events.find((event) => event.method === "turn/completed" && event.params.turn.id === turn.id);
            assert.equal(completed.params.turn.status, "completed");
        }
        return { requests, models, events, connections, queue, rpc, threadId, turn, started,
            configUnchanged: async () => assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), configuration) };
    }

    await suite.test("fresh configuration searches, fetches URLs and resumes through real Codex", async (t) => {
        const f = await fixture(t, { steps: ["web_search", "web_fetch", "web_search"] });
        await f.turn();
        assert(f.connections.length > 0);
        assert.deepEqual(f.requests.filter((req) => req.body.method === "tools/call").map((req) => req.body.params.name), ["web_search", "web_fetch", "web_search"]);
        for (const req of f.requests) {
            assert.equal(req.path, "/mcp");
            assert.equal(req.headers["user-agent"], "infinite-canvas/canvas-agent");
            assert.equal(req.headers.authorization, undefined);
        }
        const calls = f.requests.filter((req) => req.body.method === "tools/call");
        assert.deepEqual(calls[1].body.params.arguments.urls, ["https://example.com/canvas?q=art#source"]);
        assert(calls.every((req) => req.body.params.arguments.session_id === undefined));
        assert(f.models.some((request) => JSON.stringify(request.input).includes("page: canvas reference material")));
        assert(f.events.some((event) => event.method === "item/completed" && event.params.item.type === "agentMessage" && event.params.item.text === "Canvas research complete."));
        assert(!f.models[0].tools.some((tool) => tool.type === "web_search"));
        assert.equal(f.started.approvalPolicy, "on-request");
        assert.equal(f.started.sandbox.networkAccess, false);
        f.queue.push("web_search");
        await f.rpc("thread/resume", { threadId: f.threadId });
        await f.turn();
        assert.equal(f.requests.filter((req) => req.body.method === "tools/call").length, 4);
        await f.configUnchanged();
    });
    for (const mode of ["disabled", "cached", "live"]) await suite.test("preserves saved web_search=" + mode, async (t) => {
        const f = await fixture(t, { saved: 'web_search = "' + mode + '"' });
        await f.turn();
        assert.equal(f.connections.length, 0);
        assert.equal(f.models[0].tools.some((tool) => tool.type === "web_search"), mode !== "disabled");
        await f.configUnchanged();
    });
    await suite.test("preserves per-thread disable override", async (t) => {
        const f = await fixture(t, { overrides: { web_search: "disabled" } });
        await f.turn();
        assert.equal(f.connections.length, 0);
        assert(!f.models[0].tools.some((tool) => tool.type === "web_search"));
    });
    await suite.test("keeps existing MCP providers without adding a default", async (t) => {
        const f = await fixture(t, { saved: '[mcp_servers.existing]\ncommand = "not-launched"\nenabled = false' });
        await f.turn();
        assert.equal(f.connections.length, 0);
        assert(!f.models[0].tools.some((tool) => tool.name === "mcp__parallel_search"));
        assert(f.models[0].tools.some((tool) => tool.type === "web_search"));
        await f.configUnchanged();
    });
    await suite.test("preserves saved MCP disable", async (t) => {
        const f = await fixture(t, { saved: 'web_search = "disabled"\n[mcp_servers.parallel-search]\nurl = "https://search.parallel.ai/custom"\nenabled = false' });
        await f.turn();
        assert.equal(f.connections.length, 0);
        assert(!f.models[0].tools.some((tool) => tool.name === "mcp__parallel_search"));
    });
    await suite.test("preserves provider URL, credentials, headers and tool deny list", async (t) => {
        const f = await fixture(t, { saved: 'web_search = "disabled"\n[mcp_servers.parallel-search]\nurl = "https://search.parallel.ai/custom"\nhttp_headers = { "User-Agent" = "saved-client", "Authorization" = "Bearer saved-test-credential" }\ndisabled_tools = ["web_search"]', steps: ["web_fetch"] });
        await f.turn();
        const call = f.requests.find((req) => req.body.method === "tools/call");
        assert.equal(call.body.params.name, "web_fetch");
        assert.equal(call.path, "/custom");
        assert.equal(call.headers["user-agent"], "saved-client");
        assert.equal(call.headers.authorization, "Bearer saved-test-credential");
        assert(!f.models[0].tools.find((tool) => tool.name === "mcp__parallel_search").tools.some((tool) => tool.name === "web_search"));
    });
    for (const failure of ["tool", "http", "hang"]) await suite.test("surfaces " + failure + " errors without fallback", async (t) => {
        const f = await fixture(t, { failure, steps: ["web_search"], overrides: { web_search: "disabled", mcp_servers: { "parallel-search": {
            url: "https://search.parallel.ai/mcp", http_headers: { "User-Agent": "infinite-canvas/canvas-agent" }, tool_timeout_sec: 0.2,
        } } } });
        await f.turn();
        assert.equal(f.models.length, 2);
        const output = JSON.stringify(f.models[1].input);
        assert.match(output, failure === "hang" ? /timed out|timeout/i : failure === "tool" ? /Search unavailable/ : /503|Service Unavailable/);
        assert(!f.models[0].tools.some((tool) => tool.type === "web_search"));
    });
    await suite.test("interrupts an outstanding MCP call", async (t) => {
        const f = await fixture(t, { failure: "hang", steps: ["web_search"] });
        const { turn } = await f.rpc("turn/start", { threadId: f.threadId, input: [{ type: "text", text: "Search references" }] });
        await until(() => f.requests.some((req) => req.body.method === "tools/call"));
        await f.rpc("turn/interrupt", { threadId: f.threadId, turnId: turn.id });
        await until(() => f.events.some((event) => event.method === "turn/completed" && event.params.turn.id === turn.id));
        assert.equal(f.events.find((event) => event.method === "turn/completed" && event.params.turn.id === turn.id).params.turn.status, "interrupted");
        assert.equal(f.models.length, 1);
    });
});
