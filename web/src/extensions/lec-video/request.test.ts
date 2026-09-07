import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { createVideoGenerationTask } from "../../services/api/video";
import { defaultConfig, type AiConfig } from "../../stores/use-config-store";
import { createLecSeedRequest, usesLecSeedJSON } from "./request";

test("LEC Seedance sends the documented JSON through the real video request entry", async () => {
    const original = axios.defaults.adapter;
    const model = "lec-seed-2-0-900";
    const image = "data:image/png;base64,aGVsbG8=";
    const config: AiConfig = {
        ...defaultConfig, channelMode: "local", model, videoModel: model, size: "9:16",
        localChannels: [{ id: "lec", protocol: "openai", name: "test", baseUrl: "https://example.invalid", apiKey: "test-key", models: [model] }],
        activeChannelId: "lec", videoChannelId: "lec",
    };
    axios.defaults.adapter = async (request) => {
        assert.equal(request.url, "https://example.invalid/v1/videos");
        assert.match(String(request.headers.get("Content-Type")), /application\/json/);
        assert.deepEqual(JSON.parse(request.data), { model, prompt: "test", aspect_ratio: "9:16", images: [image] });
        return { data: { id: "test-task", status: "queued" }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    try {
        const task = await createVideoGenerationTask(config, "test", [{ id: "test", name: "test.png", type: "image/png", dataUrl: image }]);
        assert.equal(task.pollId, "test-task");
    } finally {
        axios.defaults.adapter = original;
    }
});

test("LEC adapter keeps scope narrow and rejects unsupported references", async () => {
    const input = { references: [], videoReferences: [], audioReferences: [], firstFrame: null, lastFrame: null };
    assert.equal(usesLecSeedJSON("lec-seed-2-0-900", "openai"), true);
    assert.equal(usesLecSeedJSON("lec-seed-2-0-900", "kie"), false);
    assert.equal(usesLecSeedJSON("sora-2", "openai"), false);
    const body = await createLecSeedRequest("lec-seed-2-0-900", "test", "1:1", input);
    assert.deepEqual(body, { model: "lec-seed-2-0-900", prompt: "test", aspect_ratio: "16:9" });
    const frame = { id: "test", name: "test.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" };
    await assert.rejects(createLecSeedRequest(body.model, "test", "16:9", { ...input, firstFrame: frame }), /不支持/);
    await assert.rejects(createLecSeedRequest(body.model, "test", "16:9", { ...input, references: Array.from({ length: 10 }, () => frame) }), /9/);
});
