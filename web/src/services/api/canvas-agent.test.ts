import { afterEach, describe, expect, it, vi } from "vitest";

import { requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

describe("canvas Antigravity CLI adapter", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        useUserStore.setState({ token: "", user: null });
    });

    it("starts and polls the selected connection-center CLI model without sending command fields", async () => {
        vi.useFakeTimers();
        useUserStore.setState({ token: "test-token" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ code: 0, data: { available: true, protocol: "gemini-cli", taskId: "task-123", taskStatus: "running", message: "running" }, msg: "" }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { available: true, protocol: "gemini-cli", taskId: "task-123", taskStatus: "succeeded", output: "画布 CLI 已响应", message: "success" }, msg: "" }));
        const config = {
            ...defaultConfig,
            model: "gemini-3.5-flash-low",
            textModel: "gemini-3.5-flash-low",
            textChannelId: "provider-antigravity",
            localChannels: [
                {
                    id: "provider-antigravity",
                    protocol: "gemini-cli" as const,
                    name: "Antigravity CLI",
                    baseUrl: "",
                    apiKey: "",
                    models: ["gemini-3.5-flash-low"],
                    capabilities: ["text" as const],
                    managed: true,
                    enabled: true,
                },
            ],
        };

        const pending = requestCanvasAgentTurn({ config, systemPrompt: "画布规则", messages: [{ role: "user", content: "只回复测试结果" }], tools: [], allowTools: false });
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toMatchObject({
            content: "画布 CLI 已响应",
            toolCalls: [],
            usedJsonFallback: true,
        });
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/v1/providers/provider-antigravity/cli/completions",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
            }),
        );
        const startBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
        expect(startBody).toMatchObject({ model: "gemini-3.5-flash-low" });
        expect(startBody).not.toHaveProperty("command");
        expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/providers/provider-antigravity/cli/model-probe/task-123/status");
    });
});
