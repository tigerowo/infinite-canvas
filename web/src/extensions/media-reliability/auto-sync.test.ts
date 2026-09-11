import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { autoSyncImage, autoSyncToCloud, clearStorageConfigCache, USER_STORAGE_PROVIDER_KEY } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

async function withStorageFixture(run: () => Promise<void>) {
    const adapter = axios.defaults.adapter;
    const fetchBefore = globalThis.fetch;
    const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
    const userBefore = useUserStore.getState();
    const events = new EventTarget();
    globalThis.fetch = (async (url: string) => {
        if (url === "/api/extensions/media-lifecycle/state") return Response.json({ code: 0, data: { epoch: 1, clearing: false } });
        throw new Error(`Unexpected fixture request: ${url}`);
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        dispatchEvent: events.dispatchEvent.bind(events),
        localStorage: { getItem: (key: string) => key === USER_STORAGE_PROVIDER_KEY ? JSON.stringify({ enabled: true, type: "s3", endpoint: "https://personal.example", bucket: "personal", accessKeyId: "fixture", secretAccessKey: "fixture" }) : null },
    } });
    axios.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { mode: "server_sqlite_s3", autoSyncAllAssets: true, allowUserProvider: true, allowUserGlobalProvider: true } } });
    clearStorageConfigCache();
    useUserStore.setState({ token: "sync-a", user: { id: "a", role: "admin" } as never });
    try { await run(); }
    finally {
        axios.defaults.adapter = adapter;
        globalThis.fetch = fetchBefore;
        clearStorageConfigCache();
        useUserStore.setState({ token: userBefore.token, user: userBefore.user });
        if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
        else Reflect.deleteProperty(globalThis, "window");
    }
}

test("automatic sync deduplicates success and allows retry after upload failure", async () => {
    await withStorageFixture(async () => {
        let calls = 0;
        const upload = async () => { calls++; return { storageKey: "server:sync-fixture" }; };
        const [a, b] = await Promise.all([autoSyncToCloud("success-fixture", upload), autoSyncToCloud("success-fixture", upload)]);
        assert.equal(calls, 1);
        assert.deepEqual(a, b);
        assert.equal(await autoSyncToCloud("failure-fixture", async () => { throw new Error("offline"); }), null);
        assert.deepEqual(await autoSyncToCloud("failure-fixture", upload), a);
        assert.equal(calls, 2);
    });
});

test("automatic sync rejects stale success and failure instead of returning a local fallback", async () => {
    await withStorageFixture(async () => {
        for (const failed of [false, true]) {
            useUserStore.setState({ token: "sync-a", user: { id: "a", role: "admin" } as never });
            await assert.rejects(autoSyncToCloud(`switched-${failed}`, async () => {
                useUserStore.setState({ token: "sync-b", user: { id: "b", role: "admin" } as never });
                if (failed) throw new Error("upload failed");
                return { storageKey: "server:old-account" };
            }), /账号已切换/);
        }
    });
});

test("generated image uses the administrator default and never caches an old account inline result", async () => {
    await withStorageFixture(async () => {
        let requests = 0;
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            if (url === "/api/extensions/media-lifecycle/state") return Response.json({ code: 0, data: { epoch: 1, clearing: false } });
            requests++;
            if (url.startsWith("data:")) return new Response(new Blob(["fixture"], { type: "image/png" }));
            assert.equal(url, "/api/v1/files");
            assert.equal((init?.body as FormData).has("provider"), false);
            useUserStore.setState({ token: "sync-b", user: { id: "b", role: "admin" } as never });
            return Response.json({ code: 0, data: { storageKey: "server:old-account", url: "/fixture.png" } });
        }) as typeof fetch;
        await assert.rejects(autoSyncImage("data:image/png;base64,Zml4dHVyZQ==", "switch-image"), /账号已切换/);
        assert.equal(requests, 2);
    });
});
