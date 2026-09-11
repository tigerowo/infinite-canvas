import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { corsRule, corsXML } from "./cors";
import { isSignedMediaURL, privateMediaURL } from "./signed-url";
import { getProxyUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

test("CORS exports read-only rules with Range and no explicit OPTIONS method", () => {
    const rule = corsRule(["https://canvas.example.test", " https://canvas.example.test ", ""]);
    assert.deepEqual(rule.AllowedOrigins, ["https://canvas.example.test"]);
    assert.deepEqual(rule.AllowedMethods, ["GET", "HEAD"]);
    assert.ok(rule.AllowedHeaders.includes("Range"));
    assert.ok(rule.ExposeHeaders.includes("Content-Range"));
    assert.ok(corsXML(["https://canvas.example.test"]).includes("<AllowedOrigin>https://canvas.example.test</AllowedOrigin>"));
});

test("private S3 and EdgeOne media downloads bypass the application proxy", () => {
    for (const url of [
        "https://bucket.example.test/file?X-Amz-Signature=fixture&X-Amz-Credential=fixture",
        "https://cdn.example.test/202407151533/d1f0b51c6894231fc12e054fcc7f0b3e/foo.jpg",
    ]) {
        assert.equal(isSignedMediaURL(url), true);
        assert.equal(getProxyUrl(url), url);
    }
    assert.equal(isSignedMediaURL("javascript:alert(1)"), false);
    assert.equal(isSignedMediaURL("https://example.test/ordinary.jpg"), false);
});

test("signed media requests deduplicate and discard cache on account change", async () => {
    const previousAdapter = axios.defaults.adapter;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
        assert.equal(url, "/api/extensions/media-lifecycle/state");
        return Response.json({ code: 0, data: { epoch: 1, clearing: false } });
    }) as typeof fetch;
    let requests = 0;
    axios.defaults.adapter = async (config) => {
        requests++;
        return { data: { code: 0, data: { url: "https://s3.example.test/" + requests, expiresAt: new Date(Date.now() + 300_000).toISOString() } }, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
        useUserStore.setState({ token: "test-session-a", user: null });
        const [a, b] = await Promise.all([privateMediaURL("object-1"), privateMediaURL("object-1")]);
        assert.equal(a, b); assert.equal(requests, 1);
        assert.equal(await privateMediaURL("object-1"), a); assert.equal(requests, 1);
        useUserStore.setState({ token: "test-session-b" });
        assert.notEqual(await privateMediaURL("object-1"), a); assert.equal(requests, 2);
        useUserStore.setState({ token: "" });
        assert.equal(await privateMediaURL("object-1"), ""); assert.equal(requests, 2);
    } finally { axios.defaults.adapter = previousAdapter; globalThis.fetch = previousFetch; useUserStore.setState({ token: "", user: null }); }
});
