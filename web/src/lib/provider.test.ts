import { describe, expect, it } from "vitest";

import { isRunningHubReference, managedProviderProtocols, providerModelChannels, type Provider } from "@/lib/provider";

describe("provider helpers", () => {
    it("accepts only explicit RunningHub app and workflow references", () => {
        expect(isRunningHubReference("app:2058517022748798977")).toBe(true);
        expect(isRunningHubReference("workflow:2058824859437850625")).toBe(true);
        expect(isRunningHubReference("2058824859437850625")).toBe(false);
        expect(isRunningHubReference("workflow:abc")).toBe(false);
    });

    it("keeps RunningHub out of OpenAI-compatible model channel syncing", () => {
        expect(managedProviderProtocols.has("runninghub")).toBe(false);
        expect(managedProviderProtocols.has("openai")).toBe(true);
        expect(managedProviderProtocols.has("http")).toBe(true);
    });

    it("maps connection center providers into the shared model catalog without secrets", () => {
        const provider = {
            id: "provider-http",
            kind: "api",
            protocol: "http",
            name: "通用接口",
            baseUrl: "https://api.example.test",
            hasApiKey: false,
            hasHeaders: true,
            capabilities: ["image"],
            models: ["custom-render"],
            defaultModel: "custom-render",
            enabled: true,
            isDefault: true,
        } as Provider;
        expect(providerModelChannels([provider])).toEqual([expect.objectContaining({ id: "provider-http", protocol: "http", apiKey: "", hasHeaders: true, capabilities: ["image"], models: ["custom-render"] })]);
    });

    it("adds connected text, subscription image, emergency image, Antigravity and Jimeng models to the shared workbench catalog", () => {
        const providers = [
            { id: "provider-codex-cli", kind: "cli", protocol: "codex", name: "Codex CLI", capabilities: [], models: [], defaultModel: "", connectionStatus: "connected", enabled: true },
            { id: "provider-gpt-image-2", kind: "cli", protocol: "gpt-image-2", name: "GPT Image 2 订阅", capabilities: ["image"], models: ["gpt-image-2"], defaultModel: "gpt-image-2", connectionStatus: "connected", enabled: true },
            { id: "provider-codex-emergency", kind: "cli", protocol: "codex-image-emergency", name: "Codex 应急生图", capabilities: ["image"], models: ["codex-image-emergency"], defaultModel: "codex-image-emergency", connectionStatus: "connected", enabled: true },
            { id: "provider-gemini-cli", kind: "cli", protocol: "gemini-cli", name: "Antigravity CLI", capabilities: ["text"], models: ["gemini-3.5-flash-low"], defaultModel: "gemini-3.5-flash-low", connectionStatus: "connected", enabled: true },
            { id: "provider-jimeng-cli", kind: "cli", protocol: "jimeng", name: "即梦 CLI", capabilities: ["image", "video"], models: ["jimeng-image-5.0", "jimeng-video-seedance2.0fast"], connectionStatus: "connected", enabled: true },
        ] as Provider[];

        expect(providerModelChannels(providers)).toEqual([
            expect.objectContaining({ id: "provider-codex-cli", protocol: "codex", models: ["codex-cli-default"], defaultModel: "codex-cli-default", capabilities: ["text"] }),
            expect.objectContaining({ id: "provider-gpt-image-2", protocol: "gpt-image-2", models: ["gpt-image-2"], capabilities: ["image"] }),
            expect.objectContaining({ id: "provider-codex-emergency", protocol: "codex-image-emergency", models: ["codex-image-emergency"], capabilities: ["image"] }),
            expect.objectContaining({ id: "provider-gemini-cli", protocol: "gemini-cli", models: ["gemini-3.5-flash-low"], capabilities: ["text"] }),
            expect.objectContaining({ id: "provider-jimeng-cli", protocol: "jimeng", models: ["jimeng-image-5.0", "jimeng-video-seedance2.0fast"], capabilities: ["image", "video"] }),
        ]);
    });
});
