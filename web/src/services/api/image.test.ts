import { afterEach, describe, expect, it, vi } from "vitest";

import { parseChatImagesPayload, requestImageQuestion } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

describe("Chat image responses", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        useUserStore.setState({ token: "", user: null });
    });

    it("extracts a Markdown-embedded image Data URL", () => {
        const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
        const images = parseChatImagesPayload({ choices: [{ message: { content: `![generated image](${dataUrl})` } }] });

        expect(images).toHaveLength(1);
        expect(images[0].dataUrl).toBe(dataUrl);
    });

    it("routes a canvas text node through the selected Antigravity CLI connection", async () => {
        vi.useFakeTimers();
        useUserStore.setState({ token: "test-token" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-123", taskStatus: "running", message: "running" } }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-123", taskStatus: "succeeded", output: "OK", message: "success" } }));
        const config = {
            ...defaultConfig,
            model: "gemini-3.5-flash-low",
            textModel: "gemini-3.5-flash-low",
            textChannelId: "provider-antigravity",
            localChannels: [{ id: "provider-antigravity", protocol: "gemini-cli" as const, name: "Antigravity CLI", baseUrl: "", apiKey: "", models: ["gemini-3.5-flash-low"], capabilities: ["text" as const], managed: true, enabled: true }],
        };
        const onDelta = vi.fn();

        const pending = requestImageQuestion(config, [{ role: "user", content: "只回复 OK" }], onDelta);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toBe("OK");
        expect(onDelta).toHaveBeenCalledWith("OK");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/providers/provider-antigravity/cli/completions");
        expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ model: "gemini-3.5-flash-low", prompt: "user: 只回复 OK" });
    });

    it("routes a canvas text node through the selected Codex CLI connection", async () => {
        vi.useFakeTimers();
        useUserStore.setState({ token: "test-token" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-codex", taskStatus: "running", message: "running" } }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-codex", taskStatus: "succeeded", output: "Codex OK", message: "success" } }));
        const config = {
            ...defaultConfig,
            model: "codex-cli-default",
            textModel: "codex-cli-default",
            textChannelId: "provider-codex",
            localChannels: [{ id: "provider-codex", protocol: "codex" as const, name: "Codex CLI", baseUrl: "", apiKey: "", models: ["codex-cli-default"], capabilities: ["text" as const], managed: true, enabled: true }],
        };
        const onDelta = vi.fn();

        const pending = requestImageQuestion(config, [{ role: "user", content: "只回复 Codex OK" }], onDelta);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toBe("Codex OK");
        expect(onDelta).toHaveBeenCalledWith("Codex OK");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/providers/provider-codex/cli/completions");
        expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ model: "codex-cli-default", prompt: "user: 只回复 Codex OK" });
    });

    it("routes a canvas text node through the selected ChatGPT subscription proxy", async () => {
        vi.useFakeTimers();
        useUserStore.setState({ token: "test-token" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-chatgpt", taskStatus: "running", message: "running" } }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-chatgpt", taskStatus: "succeeded", output: "订阅文本 OK", message: "success" } }));
        const config = {
            ...defaultConfig,
            model: "gpt-5.5",
            textModel: "gpt-5.5",
            textChannelId: "provider-chatgpt-proxy",
            localChannels: [{ id: "provider-chatgpt-proxy", protocol: "chatgpt-subscription-proxy" as const, name: "ChatGPT 订阅代理", baseUrl: "", apiKey: "", models: ["gpt-5.5"], capabilities: ["text" as const], managed: true, enabled: true }],
        };
        const onDelta = vi.fn();

        const pending = requestImageQuestion(config, [{ role: "user", content: "只回复订阅文本 OK" }], onDelta);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toBe("订阅文本 OK");
        expect(onDelta).toHaveBeenCalledWith("订阅文本 OK");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/providers/provider-chatgpt-proxy/cli/completions");
    });

    it("routes a canvas text node through the selected Gemini official CLI connection", async () => {
        vi.useFakeTimers();
        useUserStore.setState({ token: "test-token" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-gemini", taskStatus: "running", message: "running" } }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { taskId: "task-gemini", taskStatus: "succeeded", output: "Gemini CLI OK", message: "success" } }));
        const config = {
            ...defaultConfig,
            model: "flash-lite",
            textModel: "flash-lite",
            textChannelId: "provider-gemini-official",
            localChannels: [{ id: "provider-gemini-official", protocol: "gemini-official-cli" as const, name: "Gemini 官方 CLI", baseUrl: "", apiKey: "", models: ["flash-lite"], capabilities: ["text" as const], managed: true, enabled: true }],
        };
        const onDelta = vi.fn();

        const pending = requestImageQuestion(config, [{ role: "user", content: "只回复 Gemini CLI OK" }], onDelta);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toBe("Gemini CLI OK");
        expect(onDelta).toHaveBeenCalledWith("Gemini CLI OK");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/providers/provider-gemini-official/cli/completions");
        expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ model: "flash-lite", prompt: "user: 只回复 Gemini CLI OK" });
    });
});
