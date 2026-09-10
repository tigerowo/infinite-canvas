import assert from "node:assert/strict";
import test from "node:test";
import { retryableRequest, privateCacheKey, scopedMediaStore } from "./cache";
import { responsesImageState } from "../newapi/response-state";
import { durableMediaSnapshot, mapMedia } from "./snapshot";
import { useUserStore } from "@/stores/use-user-store";

test("failed config requests retry and concurrent successful reads share one request", async () => {
    let calls = 0;
    const request = retryableRequest(async () => { if (++calls === 1) throw new Error("offline"); return { enabled: true }; });
    await assert.rejects(request.get(), /offline/);
    const [a, b] = await Promise.all([request.get(), request.get()]);
    assert.equal(a, b);
    assert.equal(calls, 2);
    request.clear();
    await request.get();
    assert.equal(calls, 3);
});

test("private blob keys never adopt legacy or another account cache", () => {
    try {
        useUserStore.setState({ token: "a", user: { id: "a" } as never });
        const a = privateCacheKey("server:object");
        assert.notEqual(a, "server:object");
        useUserStore.setState({ token: "b", user: { id: "b" } as never });
        assert.notEqual(privateCacheKey("server:object"), a);
        useUserStore.setState({ user: null });
        assert.equal(privateCacheKey("server:object"), null);
    } finally { useUserStore.setState({ token: "", user: null }); }
});

test("in-flight private reads are discarded when the session changes", async () => {
    let finish!: (value: Blob) => void;
    const storage = scopedMediaStore({ getItem: () => new Promise<Blob>((resolve) => { finish = resolve; }) } as never);
    useUserStore.setState({ token: "a", user: { id: "a" } as never });
    const pending = storage.getItem("server:object");
    useUserStore.setState({ token: "b", user: { id: "b" } as never });
    finish(new Blob(["private"]));
    await assert.rejects(pending, /账号已切换/);
    useUserStore.setState({ token: "", user: null });
});

test("Responses partials and output item completion are not response completion", () => {
    assert.equal(responsesImageState({ type: "response.image_generation_call.partial_image", partial_image_b64: "preview" }), false);
    assert.equal(responsesImageState({ type: "response.output_item.done", item: { status: "completed" } }), false);
    assert.equal(responsesImageState({ type: "response.completed", response: { status: "completed" } }), true);
    for (const status of ["failed", "incomplete", "cancelled"]) assert.throws(() => responsesImageState({ response: { status } }), /未完成/);
});

test("durable asset snapshots retain keys while removing transient addresses", () => {
    const source = { kind: "image", coverUrl: "blob:old", data: { storageKey: "server:1", dataUrl: "https://s3.test/file?X-Amz-Signature=x&X-Amz-Credential=y" } };
    const snapshot = durableMediaSnapshot(source);
    assert.equal(snapshot.coverUrl, "");
    assert.equal(snapshot.data.dataUrl, "");
    assert.equal(snapshot.data.storageKey, "server:1");
    assert.equal(source.coverUrl, "blob:old");
});

test("media hydration bounds concurrency and preserves ordering", async () => {
    let active = 0, maximum = 0;
    const result = await mapMedia(Array.from({ length: 30 }, (_, i) => i), async (i) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return i;
    });
    assert.equal(maximum, 4);
    assert.deepEqual(result, Array.from({ length: 30 }, (_, i) => i));
});
