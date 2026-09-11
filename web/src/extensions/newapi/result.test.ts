import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const module = { exports: {} as { parseNewAPIVideoResponse: (value: unknown) => { id: string; video_url?: string } } };
const source = ts.transpileModule(fs.readFileSync(new URL("./request.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({}), URL });

test("only completed explicit result metadata supplies a signed video URL", () => {
    const url = "https://asset.example/video.mp4?sig=a%2Bb&expires=259200";
    for (const status of ["completed", "processing", "failed"]) {
        const result = module.exports.parseNewAPIVideoResponse({ id: "gateway", status, metadata: { canvas_video_result: { version: 1, url } } });
        assert.equal(result.id, "gateway");
        assert.equal(result.video_url, status === "completed" ? url : undefined);
    }
    for (const metadata of [{ url }, { canvas_video_result: { version: 2, url } }, { canvas_video_result: { version: 1, url: "javascript:alert(1)" } }]) {
        assert.equal(module.exports.parseNewAPIVideoResponse({ id: "gateway", status: "completed", metadata }).video_url, undefined);
    }
});
