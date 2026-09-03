import { describe, expect, it } from "vitest";

import { generationCallSummary } from "@/hooks/use-generation-confirm";
import { defaultConfig } from "@/stores/use-config-store";

describe("generationCallSummary", () => {
    it("uses the selected local channel without exposing credentials", () => {
        const config = {
            ...defaultConfig,
            channelMode: "local" as const,
            model: "mock-image",
            imageModel: "mock-image",
            imageChannelId: "mock-channel",
            activeChannelId: "mock-channel",
            localChannels: [{ id: "mock-channel", protocol: "http" as const, name: "Mock 渠道", baseUrl: "https://example.test", apiKey: "do-not-expose", models: ["mock-image"], capabilities: ["image" as const], enabled: true }],
        };
        const summary = generationCallSummary(config, "mock-image", "图片生成");
        expect(summary).toEqual({ taskType: "图片生成", model: "mock-image", channel: "Mock 渠道", protocol: "http" });
        expect(JSON.stringify(summary)).not.toContain("do-not-expose");
    });

    it("shows a managed connection-center channel in remote mode", () => {
        const config = {
            ...defaultConfig,
            channelMode: "remote" as const,
            model: "gpt-image-2",
            imageModel: "gpt-image-2",
            imageChannelId: "managed-image",
            localChannels: [{ id: "managed-image", protocol: "openai" as const, name: "连接中心生图", baseUrl: "https://example.test", apiKey: "", models: ["gpt-image-2"], capabilities: ["image" as const], managed: true, hasApiKey: true, enabled: true }],
            publicChannels: [],
        };
        expect(generationCallSummary(config, "gpt-image-2", "图片生成")).toEqual({ taskType: "图片生成", model: "gpt-image-2", channel: "连接中心生图", protocol: "openai" });
    });
});
