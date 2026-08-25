import { describe, expect, it } from "vitest";

import { filterChannelModelsByCapability, normalizeLocalChannels, type AiConfig } from "@/stores/use-config-store";

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
});
