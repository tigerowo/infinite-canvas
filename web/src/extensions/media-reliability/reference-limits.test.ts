import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function environment() {
    const modules = new Map();
    const signed: string[] = [];
    const sign = async (ref: { id: string }) => { signed.push(ref.id); return `https://media.example/${ref.id}`; };
    const load = (name: string): any => {
        if (name === "axios") return {};
        if (name.endsWith("use-config-store")) return {
            channelProtocolForConfig: (config: any) => config.protocol || "openai",
            channelIdForActiveModel: () => "fixture", localChannelForActiveModel: () => undefined,
        };
        if (name.endsWith("use-user-store")) return { useUserStore: { getState: () => ({ token: "fixture" }) } };
        if (name.endsWith("public-media/references")) return { publicImageURL: sign, publicMediaURL: sign };
        if (name.endsWith("model-capabilities/policy")) return { loadModelPolicy: async () => ({ newapiVideoProfiles: { "fixture::future-video": "canvas-v1" } }) };
        if (name.endsWith("newapi/config")) return { isNewAPIConfig: (config: any) => config.protocol === "newapi" };
        if (name.endsWith("services/image-storage")) return { imageToDataUrl: sign };
        if (name.endsWith("lib/gemini")) return { isGeminiVideoModel: () => false, isGeminiConfig: () => false };
        const filename = name.startsWith("@/") ? path.resolve("src", name.slice(2) + ".ts") : name;
        if (modules.has(filename)) return modules.get(filename).exports;
        if (!fs.existsSync(filename) || /services[/\\](file-storage|api[/\\]autodl)|media-reliability[/\\](cache|protected-media)/.test(filename)) return {};
        const module = { exports: {} };
        modules.set(filename, module);
        let source = fs.readFileSync(filename, "utf8");
        if (filename.endsWith(path.normalize("services/api/video.ts"))) source += "\nexport { createVideoRequestBody };";
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        vm.runInNewContext(compiled, { module, exports: module.exports, URL, FormData, Blob, File, console, require: (dependency: string) => load(dependency.startsWith(".") ? path.resolve(path.dirname(filename), dependency + ".ts") : dependency) }, { filename });
        return module.exports;
    };
    return { load, signed };
}
const refs = (kind: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${kind}-${index}`, name: `${kind}-${index}`, type: `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "mpeg"}`, storageKey: `server:${kind}-${index}`, dataUrl: `https://media.example/${kind}-${index}`, url: `https://media.example/${kind}-${index}` }));
const input = () => ({ references: refs("image", 34), videoReferences: refs("video", 8), audioReferences: refs("audio", 8), firstFrame: null, lastFrame: null });
const config = { model: "future-video", baseUrl: "https://fixture.invalid", protocol: "openai", videoSeconds: "6", size: "16:9", vquality: "720p", videoGenerateAudio: "false", videoMode: "pro" };

test("shared video request allows a combined 50 and rejects 51 before signing", async () => {
    const env = environment();
    const body = await env.load("@/services/api/video").createVideoRequestBody(config, config.model, "fixture", input());
    assert.equal(body.getAll("input_reference[]").length, 34);
    assert.equal(body.getAll("video_reference[]").length, 8);
    assert.equal(body.getAll("audio_reference[]").length, 8);
    assert.equal(env.signed.length, 50);
    await assert.rejects(env.load("@/services/api/video").createVideoRequestBody(config, config.model, "fixture", { ...input(), audioReferences: refs("audio", 9) }), /合计最多 50.*当前 51/);
    assert.equal(env.signed.length, 50);
});

test("NewAPI Canvas v1 keeps all references and stable public URLs", async () => {
    const env = environment();
    const body = await env.load("@/extensions/newapi/request").createNewAPIVideoRequest({ ...config, protocol: "newapi" }, config.model, "fixture", input());
    assert.equal(body.metadata.canvas_video.media.length, 50);
    assert.equal(body.metadata.canvas_video.media.at(-1).url, "https://media.example/audio-7");
    await assert.rejects(env.load("@/extensions/newapi/request").createNewAPIVideoRequest({ ...config, protocol: "newapi" }, config.model, "fixture", { ...input(), firstFrame: refs("image", 1)[0] }), /当前 51/);
});

test("Kling and CogVideo array encoders do not clip references or element resources", async () => {
    const env = environment();
    const api = env.load("@/services/api/video");
    const videoElementList = Array.from({ length: 5 }, (_, i) => ({ name: `element-${i}`, description: "fixture", references: refs("image", 6).map(ref => ({ ...ref, kind: "image" })) }));
    const kling = await api.createVideoRequestBody({ ...config, protocol: "apimart", videoElementList }, "kling-v3", "fixture", { ...input(), references: refs("image", 20), videoReferences: [], audioReferences: [] });
    assert.equal(kling.getAll("input_reference[]").length, 20);
    const elements = JSON.parse(kling.get("element_list"));
    assert.equal(elements.length, 5);
    assert.ok(elements.every((item: any) => item.element_input_urls.length === 6));
    const cog = await api.createVideoRequestBody(config, "cogvideox-3", "fixture", { ...input(), references: refs("image", 50), videoReferences: [], audioReferences: [] });
    assert.equal(cog.image_url.length, 50);
});

test("image request and canvas connections preserve 50 image references", async () => {
    const env = environment();
    const { body } = await env.load("@/extensions/newapi/image").createNewAPIImageBody({ ...config, apiMode: "responses" }, "fixture", refs("image", 50), { n: 1, quality: "auto", streamPartialImages: 0 });
    assert.equal(body.input[0].content.filter((part: any) => part.type === "input_image").length, 50);
    await assert.rejects(env.load("@/extensions/newapi/image").createNewAPIImageBody({ ...config, apiMode: "responses" }, "fixture", refs("image", 51), { n: 1, quality: "auto", streamPartialImages: 0 }), /当前 51/);
    const nodes: any[] = [...refs("image", 34), ...refs("video", 8), ...refs("audio", 8)].map(ref => ({ id: ref.id, type: ref.type.split("/")[0], title: ref.name, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: ref.url, storageKey: ref.storageKey, status: "success" } }));
    const connections = nodes.map(n => ({ id: n.id, fromNodeId: n.id, toNodeId: "target" }));
    nodes.push({ id: "target", type: "video", metadata: {} });
    const { buildNodeGenerationContext: build, canvasReferenceLimitError } = env.load("@/app/(user)/canvas/components/canvas-node-generation");
    const result = build("target", nodes, connections, "fixture");
    assert.equal(result.referenceImages.length, 34);
    assert.equal(canvasReferenceLimitError(result), "");
    assert.match(canvasReferenceLimitError({ ...result, referenceAudios: refs("audio", 9) }), /当前 51/);
    assert.equal(result.referenceVideos.length, 8);
    assert.equal(result.referenceAudios.length, 8);
    nodes.at(-1).metadata.klingElementList = Array.from({ length: 5 }, (_, i) => ({ name: "element", nodeIds: nodes.slice(i * 6, i * 6 + 6).map(n => n.id) }));
    const advanced = build("target", nodes, connections, "fixture");
    assert.equal(advanced.videoElementList.length, 5);
    assert.equal(canvasReferenceLimitError(advanced), "");
    assert.ok(advanced.videoElementList.every((item: any) => item.references.length === 6));
});
