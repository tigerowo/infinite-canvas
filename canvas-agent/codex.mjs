import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const binary = join(dirname(require.resolve("@openai/codex/package.json")), "bin/codex.js");

export class CodexClient {
    pending = new Map();
    approvals = new Set();
    nextId = 0;
    stopped = false;

    constructor(emit) {
        this.emit = emit;
        this.child = spawn(process.execPath, [binary, "app-server"], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        createInterface({ input: this.child.stdout }).on("line", (line) => {
            try {
                const message = JSON.parse(line);
                if (message.method) {
                    if (message.id !== undefined) this.approvals.add(message.id);
                    if (message.method === "serverRequest/resolved") this.approvals.delete(message.params.requestId);
                    this.emit("rpc", message);
                } else {
                    const pending = this.pending.get(message.id);
                    if (!pending) return;
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if (message.error) pending.reject(new Error(message.error.message));
                    else pending.resolve(message.result);
                }
            } catch (error) {
                this.close(new Error("Codex 输出解析失败：" + error.message));
            }
        });
        this.child.stderr.resume();
        this.child.stdin.on("error", (error) => this.close(error));
        this.child.on("error", (error) => this.close(error));
        this.child.on("exit", (code) => this.close(new Error("Codex 已退出：" + code)));
        this.ready = this.request("initialize", {
            clientInfo: { name: "infinite-canvas", title: "Infinite Canvas", version: "0.1.0" },
            capabilities: { experimentalApi: true, requestAttestation: false },
        }).then(() => this.write({ method: "initialized" }));
    }

    write(message) {
        if (this.stopped) throw new Error("Codex 已断开");
        this.child.stdin.write(JSON.stringify(message) + "\n");
    }

    request(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            const timer = setTimeout(() => {
                this.close(new Error("Codex 请求超时：" + method));
            }, 90000);
            this.pending.set(id, { resolve, reject, timer });
            try { this.write({ id, method, params }); }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    reply(id, result, error) {
        if (!this.approvals.delete(id)) return;
        this.write(error ? { id, error } : { id, result });
    }

    close(error = new Error("画布连接已关闭")) {
        if (this.stopped) return;
        this.stopped = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.approvals.clear();
        if (process.platform === "win32" && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
            spawn("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
                .on("error", () => this.child.kill());
        } else this.child.kill();
        this.emit("rpc", { method: "bridge/disconnected", params: { message: error.message } });
    }
}
