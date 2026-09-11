import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHistoryWriteQueue } from "./history-write";
import { normalizeTaskElapsedMs, preserveTerminalHistory, taskLookupMessage } from "../media-reliability/task-state";

// Execute the actual page functions with delayed IO; no supplier or application API is called.
const source = readFileSync(new URL("../../app/(user)/video/page.tsx", import.meta.url), "utf8");
function pageFunctions(names: string[], pageSource = source) {
    const parsed = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(parsed))) found.push(`const ${node.getText(parsed)};`);
        if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.push(node.getText(parsed));
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.equal(found.length, names.length);
    return ts.transpileModule(found.join("\n") + `\napi = { ${names.join(",")} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
type Log = { id: string; status: string; archiveRecovery: number; createdAt: number; task?: { archiveRecovery: number }; video?: { id: string; url: string } };
function environment(initial: Log) {
    let account = "a";
    let results = [{ id: initial.id, taskLogId: initial.id, status: "pending" }];
    const logsRef = { current: [initial] };
    const disk = new Map<string, unknown>();
    const writes: unknown[] = [];
    let archives = 0;
    const context: any = {
        api: null, logsRef, token: "token", pollingLogIdsRef: { current: new Set() },
        mediaSession: () => ({ userId: account, token: "token" }),
        assertMediaSession: (session: { userId: string }) => { if (session.userId !== account) throw new Error("账号已切换"); },
        restoreHistoryImages: async (value: unknown) => value, restoreHistoryFiles: async (value: unknown) => value,
        queueVideoHistoryWrite: createHistoryWriteQueue(), preserveTerminalHistory, taskLookupMessage,
        serializeLog: (value: unknown) => value, logStore: { setItem: async (id: string, value: unknown) => { disk.set(id, value); } },
        setLogs: () => {}, setResults: (update: (items: unknown) => typeof results) => { results = update(results); },
        shouldSyncVideoLog: () => true, saveVideoGenerationLogs: async (_token: string, items: unknown[]) => { writes.push(...items); },
        setHistorySyncError: () => {}, isCloudVideo: () => false,
        archiveGeneratedMedia: async () => { archives++; return {}; }, message: { warning: () => {} },
        isFailedVideoTask: () => true, isCompletedVideoTask: () => false, VideoRequestError: Error, errorDetail: String,
    };
    vm.runInNewContext(pageFunctions(["saveGenerationLog", "persistVideoLog", "finalizeGenerationLog", "pollPendingLogOnce", "sortVideoLogs", "createResultFromLog"]), context);
    return { context, disk, writes, logsRef, results: () => results, archives: () => archives, switchAccount: () => { account = "b"; } };
}

test("video polling and archival ignore a delayed failure from before an authorized retry", async () => {
    const old = { id: "task", status: "生成中", archiveRecovery: 0, createdAt: 1, task: { archiveRecovery: 0 } };
    const retry = { ...old, archiveRecovery: 2, task: { archiveRecovery: 2 } };
    const env = environment(retry);
    env.context.pollVideoGenerationTaskStatus = async () => ({ archiveRecovery: 0, status: "failed", error: { message: "old failure" } });
    await env.context.api.pollPendingLogOnce(old, {});
    await env.context.api.finalizeGenerationLog({ ...old, status: "成功", video: { id: "old-video", url: "https://provider.invalid/old" } });
    assert.equal(env.logsRef.current[0], retry);
    assert.equal(env.results()[0].status, "pending");
    assert.equal(env.writes.length, 0);
    assert.equal(env.archives(), 0);
    assert.equal(env.disk.size, 0);
});

test("video history removed during media restoration is not recreated", async () => {
    const old = { id: "task", status: "生成中", archiveRecovery: 0, createdAt: 1 };
    const env = environment(old);
    env.context.restoreHistoryImages = async () => { env.logsRef.current = []; return []; };
    assert.equal(await env.context.api.saveGenerationLog({ ...old, status: "成功" }), undefined);
    assert.equal(env.disk.size, 0);
});

test("video responses from a former account cannot change the new account's history", async () => {
    const old = { id: "task", status: "生成中", archiveRecovery: 0, createdAt: 1 };
    const env = environment(old);
    env.context.pollVideoGenerationTaskStatus = async () => { env.switchAccount(); return { status: "failed" }; };
    await env.context.api.pollPendingLogOnce(old, {});
    assert.equal(env.logsRef.current[0], old);
    assert.equal(env.writes.length, 0);
    assert.equal(env.disk.size, 0);
});

const imageSource = readFileSync(new URL("../../app/(user)/image/page.tsx", import.meta.url), "utf8");
test("image and video normalization preserve a recovery revision across refresh", async () => {
    for (const pageSource of [source, imageSource]) {
        const context: any = {
            api: null, restoreHistoryImages: async () => [], restoreHistoryFiles: async () => [],
            normalizeLogConfig: () => ({}), normalizeResolution: (value: string) => value, normalizeTaskElapsedMs,
        };
        vm.runInNewContext(pageFunctions(["normalizeLog"], pageSource), context);
        const log = await context.api.normalizeLog({ id: "task", status: "生成中", archiveRecovery: 7, task: { archiveRecovery: 3 } });
        assert.equal(log.archiveRecovery, 7);
    }
});

test("video history normalization repairs a previously inflated terminal duration", async () => {
    const context: any = {
        api: null, restoreHistoryImages: async () => [], restoreHistoryFiles: async () => [],
        normalizeLogConfig: () => ({}), normalizeResolution: (value: string) => value, normalizeTaskElapsedMs,
    };
    vm.runInNewContext(pageFunctions(["normalizeLog"]), context);
    const log = await context.api.normalizeLog({
        id: "task", status: "成功", createdAt: Date.parse("2026-09-10T09:59:58Z"), durationMs: 23_000_000,
        task: { created_at: "2026-09-10T10:00:00Z", completed_at: "2026-09-10T10:08:30Z" },
    });
    assert.equal(log.durationMs, 510_000);
});

test("image saving discards old recovery results before disk, UI, history or archival writes", async () => {
    const current = { id: "task", status: "生成中", archiveRecovery: 4, images: [], references: [], errors: [] };
    const context: any = {
        api: null, mediaSession: () => ({ token: "token", userId: "a" }),
        logsRef: { current: [current] }, preserveTerminalHistory,
        restoreHistoryImages: () => { throw new Error("rejected input reached media IO"); },
    };
    vm.runInNewContext(pageFunctions(["saveLog"], imageSource), context);
    await context.api.saveLog({ ...current, archiveRecovery: 0, status: "失败" });
    assert.equal(context.logsRef.current[0], current);
});

test("image saving cannot recreate a history deleted while restoring references", async () => {
    const log = { id: "task", status: "生成中", archiveRecovery: 0, images: [], references: [], errors: [] };
    const logsRef = { current: [log] };
    const context: any = {
        api: null, token: "token", mediaSession: () => ({ token: "token", userId: "a" }), assertMediaSession: () => {},
        logsRef, preserveTerminalHistory, deletedHistoryKeysRef: { current: new Set() },
        restoreHistoryImages: async () => { logsRef.current = []; return []; }, persistInlineLogImages: async (value: unknown) => value,
        imageLogIdentityKeys: (value: typeof log) => [value.id], queueImageHistoryWrite: createHistoryWriteQueue(),
        logStore: { setItem: () => { throw new Error("deleted history written"); } },
    };
    vm.runInNewContext(pageFunctions(["saveLog"], imageSource), context);
    await context.api.saveLog({ ...log, status: "成功" });
    assert.equal(logsRef.current.length, 0);
});

test("video history shows local records before the remote history request finishes", async () => {
    const pageSource = source;
    const events: string[] = [];
    let releaseRemote!: (value: Log[]) => void;
    const remote = new Promise<Log[]>((resolve) => { releaseRemote = resolve; });
    const local = [{ id: "local", status: "成功", archiveRecovery: 0, createdAt: 1 }];
    const context: any = {
        api: null,
        token: "token",
        logsRef: { current: [] },
        mediaSession: () => ({ userId: "a", token: "token" }),
        assertMediaSession: () => {},
        readStoredLogs: async () => local,
        fetchVideoGenerationLogs: async () => remote,
        mergeVideoLogs: async (remoteLogs: Log[], localLogs: Log[]) => [...remoteLogs, ...localLogs],
        sortVideoLogs: (items: Log[]) => items,
        mergeHistoryRefresh: (_snapshot: Log[], _current: Log[], incoming: Log[]) => incoming,
        queueVideoHistoryWrite: async (fn: () => Promise<Log[]>) => fn(),
        replaceStoredVideoHistory: async () => {},
        setLogs: (items: Log[]) => { events.push(items.map((item) => item.id).join(",")); },
        setHistorySyncError: () => {},
        finalizeGenerationLog: async () => {},
    };
    vm.runInNewContext(pageFunctions(["loadAccountVideoHistory"], pageSource), context);
    const pending = context.api.loadAccountVideoHistory("token");
    await Promise.resolve();
    assert.deepEqual(events, ["local"], "local history should render before waiting for remote history");
    releaseRemote([{ id: "remote", status: "成功", archiveRecovery: 0, createdAt: 2 }]);
    await pending;
});

test("video history normalization keeps the stored media URL for lazy resolution", async () => {
    let resolves = 0;
    const context: any = {
        api: null,
        restoreHistoryImages: async (value: unknown) => value,
        restoreHistoryFiles: async (value: unknown) => value,
        normalizeLogConfig: () => ({}),
        normalizeResolution: (value: string) => value,
        normalizeTaskElapsedMs,
        safeResolveMediaUrl: async () => { resolves += 1; return "https://signed.invalid/new"; },
        safeResolveImageUrl: async (_key: string | undefined, fallback: string) => fallback,
    };
    vm.runInNewContext(pageFunctions(["normalizeLog"]), context);
    const log = await context.api.normalizeLog({
        id: "task", status: "成功", createdAt: 1,
        video: { id: "video", storageKey: "server:video", url: "https://signed.invalid/stored" },
    });
    assert.equal(resolves, 0);
    assert.equal(log.video.url, "https://signed.invalid/stored");
});
