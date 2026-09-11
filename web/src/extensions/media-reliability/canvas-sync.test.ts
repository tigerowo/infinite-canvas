import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const clone = <T>(value: T): T => structuredClone(value);
function browser(server: { projects: any[]; deleted: Set<string>; online: boolean }, disk = new Map()) {
    let token = "fixture";
    const modules = new Map();
    const load = (name: string): any => {
        if (name.endsWith("media-lifecycle/session")) return { lifecycleEpoch: async () => 1 };
        if (name === "localforage") return { createInstance: () => ({ getItem: async (key: string) => clone(disk.get(key)), setItem: async (key: string, value: unknown) => disk.set(key, clone(value)) }) };
        if (/[/\\]cache(?:\.ts)?$/.test(name)) return { mediaSession: () => ({ token, userId: "owner" }), assertMediaSession: (session: any) => { if (session.token !== token) throw new Error("账号已切换"); } };
        if (name.endsWith("signed-url")) return { isSignedMediaURL: (url: string) => url.includes("X-Amz-Signature=") };
        if (name.endsWith("api/canvas-tasks")) return {
            listCanvasProjects: async () => { if (!server.online) throw new Error("offline"); return clone(server.projects); },
            syncCanvasProjects: async (_: string, projects: any[]) => { for (const p of projects) if (!server.deleted.has(p.id) && !server.projects.some((r) => r.id === p.id)) server.projects.push(clone(p)); return clone(server.projects); },
            saveCanvasProject: async (_: string, project: any, base: string) => {
                if (!server.online) throw new Error("offline");
                const current = server.projects.find((p) => p.id === project.id);
                if (server.deleted.has(project.id) || (current?.updatedAt || "") !== base) throw new Error("画布版本已更新，请重新同步");
                server.projects = [...server.projects.filter((p) => p.id !== project.id), clone(project)];
                return clone(project);
            },
        };
        const filename = name.startsWith("@/") ? path.resolve("src", name.slice(2) + ".ts") : name;
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} };
        modules.set(filename, module);
        const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        vm.runInNewContext(source, { module, exports: module.exports, Date, Map, Set, Error, console, require: (dependency: string) => load(dependency.startsWith(".") ? path.resolve(path.dirname(filename), dependency + ".ts") : dependency) }, { filename });
        return module.exports;
    };
    return { sync: load("@/extensions/media-reliability/project-sync"), load, disk, switchAccount: () => { token = "other"; } };
}
const project = (): any => ({ id: "p", updatedAt: "2026-09-10T00:00:00.000Z", nodes: [{ id: "video", type: "video", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "", status: "loading", startedAt: 1 } }, { id: "image", type: "image", position: { x: 1, y: 1 } }], connections: [] });

test("two browsers preserve completed video and remote node deletion during a stale move", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const a = browser(server), b = browser(server);
    const [av] = await a.sync.readProjectSnapshot("fixture", []);
    const [bv] = await b.sync.readProjectSnapshot("fixture", []);
    av.nodes = av.nodes.slice(0, 1);
    av.nodes[0].metadata = { status: "success", content: "https://oss/video", storageKey: "server:video", startedAt: 1 };
    av.updatedAt = "2026-09-10T00:00:01.000Z";
    await a.sync.saveProjectSnapshot("fixture", av);
    bv.nodes[0].position.x = 42;
    bv.updatedAt = "2026-09-10T00:00:02.000Z";
    await b.sync.saveProjectSnapshot("fixture", bv);
    assert.equal(server.projects[0].nodes.length, 1);
    assert.equal(server.projects[0].nodes[0].metadata.status, "success");
    assert.equal(server.projects[0].nodes[0].metadata.storageKey, "server:video");
    assert.equal(server.projects[0].nodes[0].position.x, 42);
    const reloaded = browser(server, b.disk);
    assert.equal((await reloaded.sync.readProjectSnapshot("fixture", [bv]))[0].nodes.length, 1);
});

test("deleted project is not resurrected by another browser or a pending offline save", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const b = browser(server);
    const [local] = await b.sync.readProjectSnapshot("fixture", []);
    server.online = false;
    local.title = "offline edit";
    await assert.rejects(b.sync.saveProjectSnapshot("fixture", local), /offline/);
    server.projects = []; server.deleted.add("p"); server.online = true;
    const result = await browser(server, b.disk).sync.readProjectSnapshot("fixture", [local]);
    assert.equal(result.length, 0);
    assert.equal(server.projects.length, 0);
});

test("offline save survives reload and refresh does not upload unchanged snapshots", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const b = browser(server);
    const [local] = await b.sync.readProjectSnapshot("fixture", []);
    local.title = "keep me"; local.updatedAt = "2026-09-10T00:00:02.000Z";
    server.online = false;
    await assert.rejects(b.sync.saveProjectSnapshot("fixture", local));
    server.online = true;
    const [restored] = await browser(server, b.disk).sync.readProjectSnapshot("fixture", [local]);
    assert.equal(restored.title, "keep me");
    assert.equal(restored.updatedAt, local.updatedAt);
});

test("save advances the revision when the browser clock has not advanced", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const b = browser(server);
    const [local] = await b.sync.readProjectSnapshot("fixture", []);
    local.title = "same millisecond";
    await b.sync.saveProjectSnapshot("fixture", local);
    assert.ok(server.projects[0].updatedAt > local.updatedAt);
    assert.equal(server.projects[0].title, local.title);
});

test("edits are staged while sync configuration is unavailable and survive reload", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const b = browser(server);
    const [local] = await b.sync.readProjectSnapshot("fixture", []);
    const restarted = browser(server, b.disk);
    server.online = false;
    local.title = "configuration offline";
    await restarted.sync.saveProjectSnapshot("fixture", local, false);
    assert.equal(server.projects[0].title, undefined);
    server.online = true;
    const [restored] = await browser(server, b.disk).sync.readProjectSnapshot("fixture", [local]);
    assert.equal(restored.title, local.title);
});

test("media dimensions follow real portrait and landscape sizes, preserve free resize and reject stale loads", () => {
    const env = browser({ projects: [], deleted: new Set(), online: true });
    const { applyMediaDimensions, acceptsVideoTaskUpdate } = env.load("@/extensions/media-reliability/canvas-media");
    for (const type of ["image", "video"]) {
        const node = { ...project().nodes[0], type, metadata: { content: "fixture", status: "success", startedAt: 1 } };
        const portrait = applyMediaDimensions(node, "fixture", 1080, 1920);
        assert.equal(portrait.width / portrait.height, 9 / 16);
        assert.equal(applyMediaDimensions(node, "old", 1080, 1920), node);
        assert.equal(applyMediaDimensions(portrait, "fixture", 1080, 1920), portrait);
        assert.equal(applyMediaDimensions({ ...node, metadata: { ...node.metadata, freeResize: true } }, "fixture", 1080, 1920).width, node.width);
        assert.equal(acceptsVideoTaskUpdate(node, 1), false);
        assert.equal(acceptsVideoTaskUpdate({ ...node, metadata: { ...node.metadata, content: "", storageKey: "server:video" } }, 1), false);
        assert.equal(acceptsVideoTaskUpdate(node, 2), false);
    }
});

test("failure survives another browser's stale progress and position edit", async () => {
    const server = { projects: [project()], deleted: new Set<string>(), online: true };
    const a = browser(server), b = browser(server);
    const [av] = await a.sync.readProjectSnapshot("fixture", []);
    const [bv] = await b.sync.readProjectSnapshot("fixture", []);
    Object.assign(av.nodes[0].metadata, { status: "error", errorDetails: "504 Gateway Time-out" });
    av.updatedAt = "2026-09-10T00:00:02.000Z";
    await a.sync.saveProjectSnapshot("fixture", av);
    Object.assign(bv.nodes[0].metadata, { status: "loading", progress: 1 });
    bv.nodes[0].position.x = 99;
    bv.updatedAt = "2026-09-10T00:00:03.000Z";
    await b.sync.saveProjectSnapshot("fixture", bv);
    const [result] = await browser(server).sync.readProjectSnapshot("fixture", []);
    assert.equal(result.nodes[0].metadata.status, "error");
    assert.equal(result.nodes[0].metadata.errorDetails, "504 Gateway Time-out");
    assert.equal(result.nodes[0].position.x, 99);
});

test("late progress cannot revive failure; new attempt and transient lookup can recover", () => {
    const env = browser({ projects: [], deleted: new Set(), online: true });
    const { acceptsVideoTaskUpdate } = env.load("@/extensions/media-reliability/canvas-media");
    const failed = { ...project().nodes[0], metadata: { status: "error", errorDetails: "system under load", startedAt: 1 } };
    assert.equal(acceptsVideoTaskUpdate(failed, 1), false);
    assert.equal(acceptsVideoTaskUpdate(failed, 1, "failed"), true);
    assert.equal(acceptsVideoTaskUpdate({ ...failed, metadata: { status: "loading", startedAt: 2 } }, 1), false);
    assert.equal(acceptsVideoTaskUpdate({ ...failed, metadata: { status: "loading", startedAt: 2 } }, 2), true);
    assert.equal(acceptsVideoTaskUpdate({ ...failed, metadata: { ...failed.metadata, errorDetails: "任务状态暂不可用，将自动重试：offline" } }, 1), true);
});

test("failed client-only history is syncable and stale progress preserves its error", () => {
    const env = browser({ projects: [], deleted: new Set(), online: true });
    const { shouldSyncTaskHistory, preserveTerminalHistory } = env.load("@/extensions/media-reliability/task-state");
    assert.equal(shouldSyncTaskHistory("失败", true), true);
    assert.equal(shouldSyncTaskHistory("生成中", true), false);
    const failed = { status: "失败", error: "system under load" };
    assert.equal(preserveTerminalHistory(failed, { status: "生成中" }), failed);
    assert.equal(preserveTerminalHistory(failed, { status: "成功" }).status, "成功");
});
