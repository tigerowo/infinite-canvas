import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import * as sync from "./asset-sync";
import { createHistoryWriteQueue } from "./history-write";
import { durableMediaSnapshot, mapMedia } from "../media-reliability/snapshot";

const source = readFileSync(new URL("../../stores/use-asset-store.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source + "\nexports.ready = () => assetScopeLoad;", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const asset = { id: "a1", kind: "text", title: "A 的素材", data: { content: "文字" }, coverUrl: "", tags: [], createdAt: "1", updatedAt: "1" };
function setup() {
    let user = { token: "token-a", user: { id: "a" }, isReady: true };
    const listeners: Array<(next: typeof user, previous: typeof user) => void> = [];
    const disk = new Map<string, string>();
    let epoch = 1;
    const key = (owner: string, generation = 1) => `ext:media-lifecycle:assets:user:${owner}:${generation}`;
    const snapshot = { assets: [asset], revision: "1" };
    disk.set(key("a"), JSON.stringify({ state: { assets: [asset], remoteSnapshot: snapshot } }));
    disk.set("infinite-canvas:asset_store", JSON.stringify({ state: { assets: [{ ...asset, id: "legacy" }] } }));
    const api = { fetchUserAssetData: async () => snapshot, syncUserAssetData: async (_token: string, data: typeof snapshot) => data };
    const mediaSession = () => ({ token: user.token, userId: user.user.id });
    const modules: Record<string, unknown> = {
        zustand: { create }, "zustand/middleware": { persist }, nanoid: { nanoid: () => "new-id" },
        "@/extensions/media-lifecycle/history-store": { createHistoryStore: () => ({}) },
        "@/extensions/media-lifecycle/asset-sync": sync,
        "@/extensions/media-lifecycle/history-write": { createHistoryWriteQueue },
        "@/extensions/media-lifecycle/session": { knownLifecycleEpoch: () => epoch, lifecycleEpoch: async () => epoch },
        "@/stores/use-user-store": { useUserStore: { getState: () => user, subscribe: (callback: typeof listeners[number]) => { listeners.push(callback); } } },
        "@/extensions/media-reliability/cache": { mediaSession, assertMediaSession: (session: ReturnType<typeof mediaSession>) => { if (session.token !== user.token || session.userId !== user.user.id) throw new Error("账号已切换"); } },
        "@/extensions/media-reliability/snapshot": { durableMediaSnapshot, mapMedia },
        "@/lib/localforage-storage": { localForageStorage: { getItem: async (key: string) => disk.get(key), setItem: (key: string, value: string) => { disk.set(key, value); }, removeItem: (key: string) => disk.delete(key) } },
        "@/services/image-storage": {}, "@/services/file-storage": {}, "@/services/api/user-config": api,
    };
    const exports: any = {};
    vm.runInNewContext(code, { exports, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; }, Error, console, window: { setTimeout: () => 1, clearTimeout() {} } });
    const switchTo = async (owner: string, generation = 1) => {
        epoch = generation;
        const previous = user;
        user = { ...user, token: `token-${owner}`, user: { id: owner } };
        listeners.forEach((callback) => callback(user, previous));
        await exports.ready();
    };
    return { store: exports.useAssetStore, ready: exports.ready, disk, key, api, switchTo };
}

test("actual asset store restores each account independently and leaves legacy and old epochs untouched", async () => {
    const env = setup();
    await env.ready();
    assert.equal(env.store.getState().assets[0].id, "a1");
    env.store.getState().updateAsset("a1", { title: "离线修改" });
    await env.switchTo("b");
    assert.equal(env.store.getState().assets.length, 0);
    env.store.getState().addAsset({ ...asset, title: "B 的素材" });
    await env.switchTo("a");
    assert.equal(env.store.getState().assets[0].title, "离线修改");
    await env.switchTo("b");
    await env.switchTo("a", 2);
    assert.equal(env.store.getState().assets.length, 0);
    assert.equal(JSON.parse(env.disk.get(env.key("a"))!).state.assets[0].title, "离线修改");
    assert.equal(JSON.parse(env.disk.get(env.key("b"))!).state.assets[0].title, "B 的素材");
    assert.ok(env.disk.has("infinite-canvas:asset_store"));
});

test("actual asset store preserves edits made while a successful save is in flight", async () => {
    const env = setup();
    await env.ready();
    env.api.syncUserAssetData = async (_token, data) => {
        env.store.getState().updateAsset("a1", { title: "较新的编辑" });
        return { ...data, revision: "2" };
    };
    env.store.getState().updateAsset("a1", { note: "先保存的备注" });
    await env.store.getState().hydrateAccountAssets("token-a", true);
    assert.equal(env.store.getState().assets[0].title, "较新的编辑");
    assert.equal(env.store.getState().assets[0].note, "先保存的备注");
    assert.equal(env.store.getState().remoteSnapshot.assets[0].title, "A 的素材");
});

test("actual asset store discards old network responses on account switch and exposes sync errors", async () => {
    const env = setup();
    await env.ready();
    env.api.fetchUserAssetData = async () => { await env.switchTo("b"); return { assets: [asset], revision: "1" }; };
    await assert.rejects(env.store.getState().hydrateAccountAssets("token-a", true), /账号已切换/);
    assert.equal(env.store.getState().assets.length, 0);
    await env.switchTo("a");
    env.api.fetchUserAssetData = async () => { throw new Error("网络中断"); };
    await assert.rejects(env.store.getState().hydrateAccountAssets("token-a", true), /网络中断/);
    assert.equal(env.store.getState().assets[0].id, "a1");
    assert.equal(env.store.getState().syncError, "网络中断");
});
