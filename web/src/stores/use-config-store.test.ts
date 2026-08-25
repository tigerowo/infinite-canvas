import { describe, expect, it } from "vitest";

import { defaultConfig, filterChannelModelsByCapability, modelChannelHeaders, modelChannelsForConfig, normalizeLocalChannels, resolveEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

describe("connection center model catalog", () => {
    it("prefers a managed provider without deleting its legacy fallback", () => {
        const legacy = { id: "legacy", protocol: "openai" as const, name: "主渠道", baseUrl: "https://api.example.test", apiKey: "legacy-key", models: ["gpt-test"] };
        const managed = { ...legacy, id: "provider", apiKey: "", managed: true, hasApiKey: true, enabled: true };
        const config = { localChannels: [legacy, managed] } as Partial<AiConfig>;

        expect(normalizeLocalChannels(config).map((channel) => channel.id)).toEqual(["provider"]);
        expect(config.localChannels).toHaveLength(2);

        managed.enabled = false;
        expect(normalizeLocalChannels(config).map((channel) => channel.id)).toEqual(["legacy"]);
    });

    it("uses an explicit single capability for unknown generic model names", () => {
        const channels = [{ protocol: "http" as const, models: ["custom-render"], capabilities: ["image" as const] }];
        expect(filterChannelModelsByCapability(channels, "image")).toEqual(["custom-render"]);
        expect(filterChannelModelsByCapability(channels, "text")).toEqual([]);
    });

    it("includes managed user providers in the remote model catalog", () => {
        const config = {
            ...defaultConfig,
            channelMode: "remote" as const,
            model: "gpt-image-2",
            imageModel: "gpt-image-2",
            imageChannelId: "provider-image",
            localChannels: [{ id: "provider-image", protocol: "openai" as const, name: "连接中心生图", baseUrl: "https://api.example.test", apiKey: "", models: ["gpt-image-2"], capabilities: ["image" as const], defaultModel: "gpt-image-2", managed: true, hasApiKey: true, enabled: true, isDefault: true }],
            publicChannels: [],
        };
        const effective = resolveEffectiveConfig(config, {
            availableModels: [], modelCosts: [], channels: [], defaultModel: "", defaultImageModel: "", defaultVideoModel: "", defaultTextModel: "", systemPrompt: "", systemPrompts: { image: "", video: "", text: "", workflow: "", workflowAgent: "" }, allowCustomChannel: true, allowUserRemoteChannel: true,
        }, true);

        expect(effective.models).toEqual(["gpt-image-2"]);
        expect(effective.imageModels).toEqual(["gpt-image-2"]);
        expect(effective.imageModel).toBe("gpt-image-2");
        expect(modelChannelsForConfig(effective).map((channel) => channel.id)).toEqual(["provider-image"]);
        const imageRequestConfig = { ...effective, model: effective.imageModel, activeChannelId: effective.imageChannelId };
        expect(modelChannelHeaders(imageRequestConfig)).toEqual({ "X-User-Model-Channel-ID": "provider-image" });
    });

    it("keeps public remote providers on the system channel header", () => {
        const config = { ...defaultConfig, channelMode: "remote" as const, model: "public-image", imageModel: "public-image", imageChannelId: "public-image-channel", publicChannels: [{ id: "public-image-channel", protocol: "openai" as const, name: "公共生图", models: ["public-image"] }] };
        expect(modelChannelHeaders(config)).toEqual({ "X-Model-Channel-ID": "public-image-channel" });
    });
});
