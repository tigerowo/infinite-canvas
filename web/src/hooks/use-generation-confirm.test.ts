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
});
