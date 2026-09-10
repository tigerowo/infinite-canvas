import assert from "node:assert/strict";
import test from "node:test";
import type { AdminStorageProvider } from "@/services/api/admin";
import { remapStorageDrafts, storageAccessProviderKey, validateStorageAccess } from "./draft";

const provider: AdminStorageProvider = { id: "", clientKey: "draft-a", name: "store", type: "s3", endpoint: "https://s3.example.com", region: "auto", bucket: "bucket-a", accessKeyId: "test", secretAccessKey: "", publicBaseUrl: "", pathPrefix: "canvas", username: "", password: "", weight: 1, enabled: true, ownerUserId: "", capacityBytes: 0, capacityCheckedAt: "", capacityExceeded: false };
const access = { allowedOrigins: ["https://canvas.example.com"], delivery: "s3" as const, cdnBaseUrl: "", tokenKey: "", hasTokenKey: false };

test("storage draft identity survives edits, removals and server ID assignment", () => {
    const other = { ...provider, clientKey: "draft-b", bucket: "bucket-b" };
    assert.equal(storageAccessProviderKey({ ...provider, name: "renamed", endpoint: "https://other.example.com" }), "draft-a");
    const saved = remapStorageDrafts([{ ...other, clientKey: undefined, id: "server-b" }, { ...provider, clientKey: undefined, id: "server-a" }], [provider, other]);
    assert.deepEqual(saved.map(storageAccessProviderKey), ["draft-b", "draft-a"]);
    assert.equal(remapStorageDrafts([saved[0]], [other])[0].clientKey, "draft-b");
    assert.deepEqual(remapStorageDrafts(saved, saved).map(storageAccessProviderKey), ["draft-b", "draft-a"]);
});

test("storage access accepts private S3 and retained tokens but rejects invalid CORS and CDN", () => {
    assert.doesNotThrow(() => validateStorageAccess(provider, access));
    const edge = { ...access, delivery: "edgeone-b" as const, cdnBaseUrl: "https://media.example.com", hasTokenKey: true };
    assert.doesNotThrow(() => validateStorageAccess(provider, edge));
    assert.throws(() => validateStorageAccess(provider, { ...edge, hasTokenKey: false }), /密钥/);
    assert.throws(() => validateStorageAccess(provider, { ...edge, cdnBaseUrl: "https://" }), /CDN/);
    for (const origin of ["*", "https://canvas.example.com/path", "https://u:p@canvas.example.com", "https://canvas.example.com?a=1"]) {
        assert.throws(() => validateStorageAccess(provider, { ...access, allowedOrigins: [origin] }), /跨域来源无效/);
    }
});

test("new storage drafts survive backend connection normalization", () => {
    const draft = { ...provider, endpoint: " s3.example.com/ ", region: "", bucket: " bucket-a ", accessKeyId: " test " };
    const saved = { ...provider, id: "server-a", clientKey: undefined };
    assert.equal(remapStorageDrafts([saved], [draft])[0].clientKey, "draft-a");
    const webdav = { ...draft, type: "webdav" as const, pathPrefix: " /canvas/ " };
    assert.equal(remapStorageDrafts([{ ...saved, type: "webdav", pathPrefix: "canvas" }], [webdav])[0].clientKey, "draft-a");
});
