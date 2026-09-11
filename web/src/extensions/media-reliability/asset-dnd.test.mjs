import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./asset-dnd.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { hasSupportedDrop, libraryAssetDragPayload, readAssetDrag, readDroppedFiles, userAssetDragPayload, writeAssetDrag } = module.exports;

function dragEvent({ files = [], types = [], values = {} } = {}) {
    const written = {};
    return {
        dataTransfer: {
            files,
            types,
            getData: (type) => values[type] || written[type] || "",
            setData: (type, value) => { written[type] = value; },
        },
        written,
    };
}

test("drop reads files even when the browser omits the Files type marker", () => {
    const files = [{ name: "reference.png" }];
    const event = dragEvent({ files });
    assert.equal(readDroppedFiles(event), files);
    assert.equal(hasSupportedDrop(event), true);
});

test("internal asset data takes a portable JSON fallback", () => {
    const payload = { kind: "image", dataUrl: "blob:image", title: "reference" };
    const sourceEvent = dragEvent();
    writeAssetDrag(sourceEvent, payload);
    const targetEvent = dragEvent({ types: ["text/plain"], values: { "text/plain": sourceEvent.written["text/plain"] } });
    assert.equal(JSON.stringify(readAssetDrag(targetEvent)), JSON.stringify(payload));
});

test("user and library cards share the same drag payload mapping", () => {
    const userPayload = userAssetDragPayload({ id: "mine", kind: "video", title: "clip", data: { url: "blob:clip", storageKey: "server:1", width: 1280, height: 720, bytes: 10, mimeType: "video/mp4" } });
    assert.equal(JSON.stringify(userPayload), JSON.stringify({ kind: "video", url: "blob:clip", storageKey: "server:1", title: "clip", assetId: "mine", bytes: 10, mimeType: "video/mp4", width: 1280, height: 720, source: "asset" }));
    const libraryPayload = libraryAssetDragPayload({ id: "public", type: "image", title: "still", url: "https://example.invalid/still.png" });
    assert.equal(JSON.stringify(libraryPayload), JSON.stringify({ kind: "image", dataUrl: "https://example.invalid/still.png", title: "still", assetId: "public", mimeType: "image/*", source: "library" }));
});
