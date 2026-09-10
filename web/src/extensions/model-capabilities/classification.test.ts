import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, filterChannelModelsByCapability, modelMatchesCapability, resolveModelForCapability, selectableModelOptions } from "../../stores/use-config-store";

const videoAliases = ["lec-mj-wan-3-0-1080p", "lec-seed-2-0-900", "lec-seed-2-5-900"];

test("AutoDL options preserve workflow lookup context and exclude audio from video selection", () => {
    const models = ["minimax_h3_video", "wan2.2animate-v4-motion_retargeting", "indextts2-v1"];
    const config = { ...defaultConfig, channelMode: "remote" as const, models, publicChannels: [
        { id: "autodl", protocol: "autodl" as const, baseUrl: "https://autodl.example", models },
    ] };
    const options = selectableModelOptions(config, "video");
    assert.deepEqual(options.map((option) => option.model), models.slice(0, 2));
    assert.equal(options[0].protocol, "autodl");
    assert.equal(options[0].baseUrl, "https://autodl.example");
    assert.equal(resolveModelForCapability(config, "", "audio"), "indextts2-v1");
});

test("model picker excludes unpublished models and preserves selectable channel identities", () => {
    const config = { ...defaultConfig, channelMode: "remote" as const, models: ["sora-video", "gpt-5.5"], publicChannels: [
        { id: "a", protocol: "newapi" as const, models: ["sora-video", "sora-video", "sora-2", "gpt-5.5"] },
        { id: "b", protocol: "newapi" as const, models: ["sora-video"] },
        { id: "off", enabled: false, models: ["sora-video"] },
    ] };
    assert.deepEqual(selectableModelOptions(config, "video").map((option) => option.key), ["a::sora-video", "b::sora-video"]);
    for (const option of selectableModelOptions(config, "video")) assert.equal(resolveModelForCapability(config, option.model, "video"), option.model);
    assert.deepEqual(selectableModelOptions({ ...config, models: [] }, "video"), []);
});

test("verified video aliases are selectable as video, never text", () => {
    const models = [...videoAliases, "wan3.0-image", "gpt-5.4"];
    const channels = [{ protocol: "openai" as const, models }];
    assert.deepEqual(filterChannelModelsByCapability(channels, "video"), videoAliases);
    assert.deepEqual(filterChannelModelsByCapability(channels, "text"), ["gpt-5.4"]);
    assert.deepEqual(filterChannelModelsByCapability(channels, "image"), ["wan3.0-image"]);
    for (const model of videoAliases) {
        assert.equal(modelMatchesCapability(` ${model.toUpperCase()} `, "video"), true);
        assert.equal(modelMatchesCapability(model, "audio"), false);
    }
    assert.equal(modelMatchesCapability("lec-seed-unknown", "video"), false);
});

test("remote automatic selection chooses a model for the requested capability", () => {
    const config = {
        ...defaultConfig,
        channelMode: "remote" as const,
        model: "",
        imageModel: "",
        videoModel: "",
        textModel: "",
        audioModel: "",
        models: ["gpt-image-2", "sora-video", "gpt-5.5"],
        publicChannels: [{ id: "gateway", protocol: "newapi" as const, models: ["gpt-image-2", "sora-video", "gpt-5.5"] }],
    };
    assert.equal(resolveModelForCapability(config, "", "image"), "gpt-image-2");
    assert.equal(resolveModelForCapability(config, "", "video"), "sora-video");
    assert.equal(resolveModelForCapability(config, "", "text"), "gpt-5.5");
});

test("remote models cannot fall back to stale defaults or unavailable node models", () => {
    const models = ["gpt-image-2", "sora-video", "gpt-5.5", "gpt-4o-mini-tts"];
    const config = { ...defaultConfig, channelMode: "remote" as const, models, publicChannels: [{ id: "gateway", protocol: "newapi" as const, models }] };
    assert.equal(resolveModelForCapability(config, " gpt-5.5 ", "text"), "gpt-5.5");
    assert.equal(resolveModelForCapability(config, "gpt-image-2", "video"), "sora-video");
    assert.equal(resolveModelForCapability(config, "removed-video", "video"), "sora-video");
    assert.equal(resolveModelForCapability(config, "", "audio"), "gpt-4o-mini-tts");
    const removed = { ...config, models: ["gpt-image-2"] };
    assert.equal(resolveModelForCapability(removed, "sora-video", "video"), "");
    for (const capability of ["image", "video", "text", "audio"] as const) {
        assert.equal(resolveModelForCapability({ ...config, publicChannels: [] }, "gpt-image-2", capability), "");
    }
});
