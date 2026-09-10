import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import axios from "axios";
import { defaultConfig, normalizeLocalChannels, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useModelPolicy } from "@/extensions/model-capabilities/policy";
import { createNewAPIVideoRequest, newAPIVideoSize, parseNewAPIVideoResponse } from "./request";
import { createVideoGenerationTask, pollVideoGenerationTaskStatus } from "@/services/api/video";
import { requestEdit, requestGeneration, fetchImageModels } from "@/services/api/image";
import { requestAudioGeneration } from "@/services/api/audio";
import { requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import { hydrateNodeGenerationContext, type NodeGenerationContext } from "@/app/(user)/canvas/components/canvas-node-generation";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hmsAAAAASUVORK5CYII=";
const image = { id: "image-1", name: "reference.png", type: "image/png", dataUrl: png };
const noReferences = { references: [], firstFrame: null, lastFrame: null, videoReferences: [], audioReferences: [] };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(() => Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } }));
after(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); });
function config(model = "cogvideox-3"): AiConfig {
    useUserStore.setState({ token: "" });
    useModelPolicy.setState({ loadedAt: Date.now() + 60000, policy: { imageTransfer: "base64", overrides: {} } });
    return { ...defaultConfig, model, videoModel: model, textModel: model, audioModel: model, imageModel: model,
        channelMode: "local", activeChannelId: "gateway", videoChannelId: "gateway", imageChannelId: "gateway", audioChannelId: "gateway", textChannelId: "gateway",
        localChannels: [{ id: "gateway", protocol: "newapi", name: "gateway", baseUrl: "https://gateway.example/v1", apiKey: "test-key", models: [model] }],
        size: "9:16", vquality: "720", videoSeconds: "15", videoGenerateAudio: "false", videoNegativePrompt: "", count: "1", apiMode: "images", streamImages: "",
        systemPrompt: "", systemPrompts: { ...defaultConfig.systemPrompts, text: "", image: "", video: "" },
    };
}

test("NewAPI video never uses provider routes, duration rules or video_id", async () => {
    const original = axios.defaults.adapter;
    try {
        for (const model of ["cogvideox-3", "Agnes-Video-V2.0", "lec-seed-2-0-900", "doubao-seedance-2-5"]) {
            const cfg = config(model);
            const calls: Array<{ url?: string; data: unknown }> = [];
            axios.defaults.adapter = async (request) => {
                calls.push({ url: request.url, data: request.data });
                return { config: request, status: 200, statusText: "OK", headers: {}, data: { id: "gateway-task", video_id: "video_provider", status: "queued", metadata: { url: "https://example.org/input.png" } } };
            };
            const created = await createVideoGenerationTask(cfg, "test");
            assert.equal(created.pollId, "gateway-task");
            assert.equal(calls[0].url, "https://gateway.example/v1/videos");
            const body = JSON.parse(calls[0].data as string);
            assert.deepEqual(body, { model, prompt: "test", seconds: "15", size: "720x1280" });
            await pollVideoGenerationTaskStatus(cfg, created.task);
            assert.equal(calls[1].url, "https://gateway.example/v1/videos/gateway-task");
        }
    } finally { axios.defaults.adapter = original; }
});

test("standard reference is an actual multipart file; unsupported inputs fail", async () => {
    const cfg = config();
    const body = await createNewAPIVideoRequest(cfg, cfg.model, "test", { ...noReferences, references: [image] });
    assert.ok(body instanceof FormData);
    const file = body.get("input_reference");
    assert.ok(file instanceof Blob && file.size > 0 && file.type === "image/png");
    assert.equal(body.has("input_reference[]"), false);
    await assert.rejects(createNewAPIVideoRequest(cfg, cfg.model, "test", { ...noReferences, references: [image, image] }), /标准协议/);
    await assert.rejects(createNewAPIVideoRequest({ ...cfg, videoSeconds: "1.5" }, cfg.model, "test", noReferences), /整数秒/);
    assert.equal(newAPIVideoSize("1:1", "720"), "720x720");
});

test("NewAPI video rejects an empty model before sending a request", async () => {
    const cfg = config("");
    await assert.rejects(createNewAPIVideoRequest({ ...cfg, model: "", videoModel: "" }, "", "test", noReferences), /模型名称不能为空/);
    const adapter = axios.defaults.adapter;
    let calls = 0;
    axios.defaults.adapter = async () => { calls++; throw new Error("unexpected request"); };
    try {
        await assert.rejects(createVideoGenerationTask({ ...cfg, model: " ", videoModel: "" }, "test"), /模型名称不能为空/);
        await assert.rejects(createVideoGenerationTask({ ...config("video-model"), videoSeconds: "31" }, "test"), /1 到 30/);
        assert.equal(calls, 0);
    } finally { axios.defaults.adapter = adapter; }
});

test("NewAPI preserves custom durations through 30 seconds in JSON and multipart", async () => {
    const cfg = config("custom-video");
    for (const seconds of ["1", "16", "30"]) {
        const requestConfig = { ...cfg, videoSeconds: seconds };
        const json = await createNewAPIVideoRequest(requestConfig, cfg.model, "test", noReferences);
        assert.ok(!(json instanceof FormData));
        assert.equal(json.seconds, seconds);
        const multipart = await createNewAPIVideoRequest(requestConfig, cfg.model, "test", { ...noReferences, references: [image] });
        assert.ok(multipart instanceof FormData);
        assert.equal(multipart.get("seconds"), seconds);
    }
    for (const seconds of ["0", "31", "1.5", "invalid"]) {
        await assert.rejects(createNewAPIVideoRequest({ ...cfg, videoSeconds: seconds }, cfg.model, "test", noReferences), /1 到 30/);
    }
    useModelPolicy.setState({ policy: { imageTransfer: "base64", overrides: {}, newapiVideoProfiles: { "gateway::custom-video": "canvas-v1" } } });
    const extended = await createNewAPIVideoRequest({ ...cfg, videoSeconds: "30" }, cfg.model, "test", { ...noReferences, references: [image], lastFrame: image });
    assert.ok(!(extended instanceof FormData) && "metadata" in extended);
    assert.equal(extended.seconds, "30");
});

test("canvas preprocessing keeps local NewAPI images usable without login", async () => {
    config();
    const context = { referenceImages: [image], firstFrame: image, lastFrame: null } as NodeGenerationContext;
    const hydrated = await hydrateNodeGenerationContext(context, "newapi");
    assert.equal(hydrated.referenceImages[0].dataUrl, png);
    assert.equal(hydrated.firstFrame?.dataUrl, png);
});

test("Canvas v1 is scoped to channel and model and preserves roles", async () => {
    const cfg = config("custom-video");
    useModelPolicy.setState({ policy: { imageTransfer: "base64", overrides: {}, newapiVideoProfiles: { "gateway::custom-video": "canvas-v1" } } });
    const body = await createNewAPIVideoRequest(cfg, cfg.model, "test", { ...noReferences, references: [image], lastFrame: image });
    assert.ok(!(body instanceof FormData) && "metadata" in body);
    assert.deepEqual(body.metadata.canvas_video.media.map((item) => item.role), ["reference", "last_frame"]);
    assert.equal(body.metadata.canvas_video.media[0].url, png);
    await assert.rejects(createNewAPIVideoRequest(cfg, "other-video", "test", { ...noReferences, references: [image, image] }), /标准协议/);
});

test("unknown states and metadata URLs cannot manufacture a completed task", () => {
    assert.throws(() => parseNewAPIVideoResponse({ id: "t", status: "future" }), /未知/);
    const task = parseNewAPIVideoResponse({ id: "t", status: "in_progress", url: "https://example.org/input.png", video_id: "video_wrong" });
    assert.equal(task.url, undefined);
    assert.equal(task.status, "in_progress");
});

test("image editing sends file bytes even for provider-looking model names", async () => {
    const cfg = config("glm-image");
    const original = globalThis.fetch;
    let submitted: FormData | undefined;
    globalThis.fetch = (async (url, init) => {
        if (String(url).startsWith("data:")) return original(url, init);
        assert.equal(url, "https://gateway.example/v1/images/edits");
        submitted = init?.body as FormData;
        return Response.json({ data: [{ b64_json: "AAAA" }] });
    }) as typeof fetch;
    try {
        await requestEdit(cfg, "test", [image]);
        assert.ok(submitted?.get("image") instanceof Blob);
        assert.equal(submitted?.get("model"), "glm-image");
    } finally { globalThis.fetch = original; }
});

test("failed image and agent submissions are never retried or stripped", async () => {
    const cfg = config("custom-model");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "tools not supported" } }, { status: 503 }); }) as typeof fetch;
    try {
        await assert.rejects(requestGeneration(cfg, "test"));
        assert.equal(calls, 1);
        calls = 0;
        await assert.rejects(requestCanvasAgentTurn({ config: cfg, systemPrompt: "test", messages: [{ role: "user", content: "test" }], tools: [], toolMode: "native" }));
        assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
});

test("speech and model discovery ignore provider model names and URL heuristics", async () => {
    const original = axios.defaults.adapter;
    try {
        const cfg = config("mimo-v2.5-tts");
        const calls: Array<{ url?: string; data: unknown }> = [];
        axios.defaults.adapter = async (request) => {
            calls.push({ url: request.url, data: request.data });
            return { config: request, status: 200, statusText: "OK", headers: {}, data: request.method === "get" ? { data: [{ id: "custom" }] } : new Blob(["audio"], { type: "audio/mpeg" }) };
        };
        await requestAudioGeneration(cfg, "test");
        assert.equal(calls[0].url, "https://gateway.example/v1/audio/speech");
        const body = JSON.parse(calls[0].data as string);
        assert.equal(body.input, "test");
        assert.equal(body.messages, undefined);
        assert.deepEqual(await fetchImageModels(cfg), ["custom"]);
        assert.equal(calls[1].url, "https://gateway.example/v1/models");
    } finally { axios.defaults.adapter = original; }
});

test("old channel configs retain their protocol", () => {
    const cfg = config();
    assert.equal(normalizeLocalChannels({ ...cfg, localChannels: [{ ...cfg.localChannels[0], protocol: "openai" }] })[0].protocol, "openai");
    assert.equal(defaultConfig.localChannels[0].protocol, "newapi");
    const legacy = normalizeLocalChannels({ baseUrl: "https://legacy.example", apiKey: "legacy-key", models: ["old-model"] });
    assert.equal(legacy[0].protocol, "openai");
    assert.equal(legacy[0].baseUrl, "https://legacy.example");
    assert.deepEqual(legacy[0].models, ["old-model"]);
});
