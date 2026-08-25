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
});
