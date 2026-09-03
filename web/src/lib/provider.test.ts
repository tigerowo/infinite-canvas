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

    it("only exposes verified CLI models while retaining the managed channel identity", () => {
        const providers = [
            { id: "provider-codex-cli", kind: "cli", protocol: "codex", name: "Codex CLI", capabilities: [], models: ["codex-cli-default"], verifiedModels: ["codex-cli-default"], defaultModel: "codex-cli-default", connectionStatus: "connected", enabled: true },
            { id: "provider-gpt-image-2", kind: "cli", protocol: "gpt-image-2", name: "GPT Image 2 订阅", capabilities: ["image"], models: ["gpt-image-2"], verifiedModels: ["gpt-image-2"], defaultModel: "gpt-image-2", connectionStatus: "connected", enabled: true },
            { id: "provider-codex-emergency", kind: "cli", protocol: "codex-image-emergency", name: "Codex 应急生图", capabilities: ["image"], models: ["codex-image-emergency"], verifiedModels: ["codex-image-emergency"], defaultModel: "codex-image-emergency", connectionStatus: "connected", enabled: true },
            { id: "provider-gemini-cli", kind: "cli", protocol: "gemini-cli", name: "Antigravity CLI", capabilities: ["text", "image"], models: ["gemini-3.7-flash-high", "gemini-3.7-flash-low", "gemini-3.6-flash-low", "nano-banana-2"], verifiedModels: ["gemini-3.7-flash-low", "gemini-3.6-flash-low", "nano-banana-2"], defaultModel: "gemini-3.7-flash-high", connectionStatus: "connected", enabled: true },
            { id: "provider-gemini-official", kind: "cli", protocol: "gemini-official-cli", name: "Gemini 官方 CLI", capabilities: ["text"], models: ["flash-lite", "flash", "pro", "auto"], verifiedModels: [], defaultModel: "flash-lite", connectionStatus: "connected", enabled: true },
            { id: "provider-jimeng-cli", kind: "cli", protocol: "jimeng", name: "即梦 CLI", capabilities: ["image", "video"], models: ["jimeng-image-5.0", "jimeng-video-seedance2.0fast"], verifiedModels: ["jimeng-image-5.0", "jimeng-video-seedance2.0fast"], connectionStatus: "connected", enabled: true },
            { id: "provider-chatgpt-proxy", kind: "cli", protocol: "chatgpt-subscription-proxy", name: "ChatGPT 订阅代理", capabilities: ["text", "image"], models: ["gpt-5.5", "gpt-image-2", "unexpected-model"], verifiedModels: ["gpt-5.5", "gpt-image-2"], defaultModel: "gpt-5.5", connectionStatus: "connected", enabled: true },
            { id: "provider-antigravity-proxy", kind: "cli", protocol: "antigravity-subscription-proxy", name: "Antigravity 订阅代理", capabilities: ["text", "image"], models: ["gemini-3.1-flash-lite", "gemini-3.1-flash-image"], verifiedModels: ["gemini-3.1-flash-image"], defaultModel: "gemini-3.1-flash-lite", connectionStatus: "connected", enabled: true },
        ] as Provider[];

        expect(providerModelChannels(providers)).toEqual([
            expect.objectContaining({ id: "provider-codex-cli", protocol: "codex", models: ["codex-cli-default"], defaultModel: "codex-cli-default", capabilities: ["text"] }),
            expect.objectContaining({ id: "provider-gpt-image-2", protocol: "gpt-image-2", models: ["gpt-image-2"], capabilities: ["image"] }),
            expect.objectContaining({ id: "provider-codex-emergency", protocol: "codex-image-emergency", models: ["codex-image-emergency"], capabilities: ["image"] }),
            expect.objectContaining({ id: "provider-gemini-cli", protocol: "gemini-cli", models: ["gemini-3.7-flash-low", "gemini-3.6-flash-low", "nano-banana-2"], defaultModel: "gemini-3.7-flash-low", capabilities: ["text", "image"] }),
            expect.objectContaining({ id: "provider-gemini-official", protocol: "gemini-official-cli", models: [], defaultModel: "", capabilities: ["text"] }),
            expect.objectContaining({ id: "provider-jimeng-cli", protocol: "jimeng", models: ["jimeng-image-5.0", "jimeng-video-seedance2.0fast"], capabilities: ["image", "video"] }),
            expect.objectContaining({ id: "provider-chatgpt-proxy", protocol: "chatgpt-subscription-proxy", models: ["gpt-5.5", "gpt-image-2"], defaultModel: "gpt-5.5", capabilities: ["text", "image"] }),
            expect.objectContaining({ id: "provider-antigravity-proxy", protocol: "antigravity-subscription-proxy", models: ["gemini-3.1-flash-image"], defaultModel: "gemini-3.1-flash-image", capabilities: ["text", "image"] }),
        ]);
    });
});
