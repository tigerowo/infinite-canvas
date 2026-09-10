import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { webcrypto } from "node:crypto";

// Execute complete source modules against an isolated browser/storage boundary.
// Recreating the module graph with the same disk models a real page reload.
function browser(disk = new Map<string, unknown>()) {
    let state = { token: "a-token", user: { id: "a", role: "admin" } };
    const listeners: Array<(next: typeof state, old: typeof state) => void> = [];
    const calls: Array<{ url: string; method: string; owner: string }> = [];
    let uploads = 0;
    let beforeSign: (() => void) | undefined;
    const modules = new Map<string, any>();
    const user = { getState: () => state, subscribe: (fn: any) => listeners.push(fn) };
    const switchUser = () => { const old = state; state = { token: "b-token", user: { id: "b", role: "admin" } }; listeners.forEach((fn) => fn(state, old)); };
    const response = (data: unknown) => ({ ok: true, json: async () => ({ code: 0, data }) });
    const fetch = async (url: string, init: any = {}) => {
        calls.push({ url, method: init.method || "GET", owner: init.headers?.Authorization || "" });
        if (url.endsWith("/resolve")) return response({});
        if (url.includes("/public-media/files/")) {
            beforeSign?.();
            return response({ url: `https://media.example/${state.user.id}/file`, expiresAt: new Date(Date.now() + 86400000).toISOString(), mimeType: "image/png" });
        }
        if (url === "/api/v1/files") { uploads++; return response({ storageKey: "server:uploaded", url: "/api/files/uploaded/content" }); }
        if (url.endsWith("/import")) return response({ storageKey: "server:imported", url: "/api/files/imported/content", mimeType: "video/mp4", bytes: 7 });
        return { ok: true, headers: new Headers({ "Content-Type": "image/png" }), blob: async () => new Blob(["fixture"], { type: "image/png" }) };
    };
    const localforage = { createInstance: ({ storeName }: any) => ({
        getItem: async (key: string) => disk.get(`${storeName}:${key}`) ?? null,
        setItem: async (key: string, value: unknown) => { disk.set(`${storeName}:${key}`, value); return value; },
        removeItem: async (key: string) => { disk.delete(`${storeName}:${key}`); },
        iterate: async (fn: any) => { for (const [key, value] of disk) if (key.startsWith(storeName + ":")) fn(value, key.slice(storeName.length + 1)); },
    }) };
    class Reader {
        result = ""; onload?: () => void;
        async readAsDataURL(blob: Blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`; this.onload?.(); }
    }
    const load = (name: string): any => {
        if (name === "localforage") return localforage;
        if (name === "nanoid") return { nanoid: () => "local-fixture" };
        if (name.endsWith("use-user-store")) return { useUserStore: user };
        if (name.endsWith("use-asset-store")) return { useAssetStore: { getState: () => ({ assets: [] }) } };
        if (name.endsWith("image-utils")) return { readImageMeta: async () => ({ width: 1, height: 1, mimeType: "image/png" }) };
        if (name.endsWith("anonymous-storage")) return {};
        if (name.endsWith("api/request")) return { apiGet: async () => ({ mode: "server_sqlite_s3", allowUserGlobalProvider: true, autoSyncAllAssets: true }) };
        if (name.endsWith("model-capabilities/policy")) return { loadModelPolicy: async () => ({ imageTransfer: "url" }) };
        if (name.endsWith("storage-access/signed-url")) return { isSignedMediaURL: () => false, privateMediaURL: async (id: string) => `https://media.example/${id}` };
        const filename = name.startsWith("@/") ? path.resolve("src", name.slice(2) + ".ts") : name;
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} };
        modules.set(filename, module);
        const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        vm.runInNewContext(source, {
            module, exports: module.exports, require: (dependency: string) => load(dependency.startsWith(".") ? path.resolve(path.dirname(filename), dependency + ".ts") : dependency),
            URL, Blob, File, FormData, TextEncoder, crypto: webcrypto, FileReader: Reader, fetch, console,
            window: { dispatchEvent() {}, localStorage: { getItem: () => null } }, CustomEvent,
        }, { filename });
        return module.exports;
    };
    return { disk, calls, load, switchUser, signHook: (fn: () => void) => { beforeSign = fn; }, uploads: () => uploads };
}

test("model signing reuses server identity and discards an account switched response", async () => {
    const app = browser();
    const { publicImageURL } = app.load("@/extensions/public-media/references");
    const ref = { storageKey: "server:fixture", url: "blob:fixture" };
    await publicImageURL(ref); await publicImageURL(ref);
    assert.equal(app.calls.filter((c) => c.url.includes("/public-media/")).length, 1);
    assert.equal(app.uploads(), 0);
    app.signHook(app.switchUser);
    await assert.rejects(publicImageURL({ storageKey: "server:another" }), /账号已切换/);
});

test("local reference and signed conversation URL survive reload without uploading again", async () => {
    const disk = new Map<string, unknown>();
    const app = browser(disk);
    const signed = await app.load("@/extensions/public-media/references").publicImageURL({ storageKey: "image:local", url: "blob:local" });
    assert.equal(app.uploads(), 1);
    const reloaded = browser(disk);
    const { publicImageURL } = reloaded.load("@/extensions/public-media/references");
    await publicImageURL({ storageKey: "image:local", url: "blob:local" });
    await publicImageURL({ url: signed });
    assert.equal(reloaded.uploads(), 0);
    assert.equal(reloaded.calls.filter((c) => c.url.includes("/public-media/")).length, 1);
    reloaded.switchUser();
    await publicImageURL({ url: signed });
    assert.equal(reloaded.calls.some((c) => c.url.endsWith("/resolve") && c.owner === "Bearer b-token"), true);
});

test("image conversion caches one body read and prefers it over a remote fallback", async () => {
    const app = browser();
    const images = app.load("@/services/image-storage");
    const ref = { storageKey: "server:fixture", url: "https://fallback.example/image" };
    await Promise.all([images.imageToDataUrl(ref), images.imageToDataUrl(ref)]);
    assert.equal(app.calls.length, 1);
    await images.imageToDataUrl(ref);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].url.includes("fallback.example"), false);
});

test("history cleanup never deletes cloud objects or an offline only copy", async () => {
    const app = browser();
    const images = app.load("@/services/image-storage");
    const media = app.load("@/services/file-storage");
    await images.setImageBlob("image:only-copy", new Blob(["offline"]));
    await images.setImageBlob("server:shared", new Blob(["cache"]));
    await images.deleteStoredImages(["image:only-copy", "server:shared"]);
    await media.setMediaBlob("video:only-copy", new Blob(["offline"]));
    await media.cleanupUnusedMedia({});
    assert.ok(await images.getImageBlob("image:only-copy"));
    assert.ok(await media.getMediaBlob("video:only-copy"));
    assert.equal(await images.getImageBlob("server:shared"), null);
    assert.equal(app.calls.length, 0);
});

test("remote archive sends only a source URL and automatic sync survives reload", async () => {
    const app = browser();
    const media = app.load("@/services/file-storage");
    await media.uploadRemoteMediaToServer("https://generator.example/video.mp4", "video", true);
    assert.deepEqual(app.calls.map((c) => c.url), ["/api/extensions/media-archive/import"]);
    const images = app.load("@/services/image-storage");
    let uploads = 0;
    await images.autoSyncToCloud("image:result", async () => { uploads++; return { storageKey: "server:result", bytes: 7, mimeType: "image/png", width: 20, height: 30 }; });
    const reload = browser(app.disk);
    const restored = await reload.load("@/services/image-storage").autoSyncToCloud("image:result", async () => { uploads++; return { storageKey: "server:duplicate" }; });
    assert.equal(uploads, 1);
    assert.equal(restored.bytes, 7);
    assert.equal(restored.width, 20);
    assert.equal(restored.mimeType, "image/png");
});

test("a promoted local image still reads its original complete blob without network", async () => {
    const app = browser();
    const images = app.load("@/services/image-storage");
    await images.setImageBlob("image:original", new Blob(["local"], { type: "image/png" }));
    await app.load("@/extensions/media-reliability/identity").rememberMediaIdentity("image:original", "server:promoted");
    const result = await images.imageToDataUrl({ storageKey: "image:original", url: "https://remote.example/image" });
    assert.ok(result.startsWith("data:image/png;base64,"));
    assert.equal(app.calls.length, 0);
});

test("protected video reuses cloud and offline results across concurrent polls and reloads", async () => {
    for (const storageKey of ["server:video", "generated-video:offline"]) {
        const app = browser();
        let downloads = 0;
        const create = async () => { downloads++; return { storageKey, url: "blob:video" }; };
        const resolve = async (key: string) => key === storageKey ? "blob:cached" : "";
        const { reuseProtectedMedia } = app.load("@/extensions/media-reliability/protected-media");
        await Promise.all([reuseProtectedMedia("task:1", resolve, create), reuseProtectedMedia("task:1", resolve, create)]);
        const reload = browser(app.disk);
        await reload.load("@/extensions/media-reliability/protected-media").reuseProtectedMedia("task:1", resolve, create);
        assert.equal(downloads, 1);
        reload.switchUser();
        await reload.load("@/extensions/media-reliability/protected-media").reuseProtectedMedia("task:1", resolve, create);
        assert.equal(downloads, 2);
    }
});

test("protected download failure can retry and switched responses are not persisted", async () => {
    const app = browser();
    const { reuseProtectedMedia } = app.load("@/extensions/media-reliability/protected-media");
    await assert.rejects(reuseProtectedMedia("task:1", async () => "", async () => { throw new Error("download failed"); }), /download failed/);
    await assert.rejects(reuseProtectedMedia("task:1", async () => "", async () => { app.switchUser(); return { storageKey: "server:a", url: "blob:a" }; }), /账号已切换/);
    assert.equal([...app.disk.keys()].filter((key) => key.startsWith("ext_protected_media:")).length, 0);
    const result = await reuseProtectedMedia("task:1", async () => "", async () => ({ storageKey: "server:b", url: "blob:b" }));
    assert.equal(result.storageKey, "server:b");
});
