import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CLIHelperResult } from "@/lib/provider";
import { createCanvasImageTask, pollCanvasImageTaskStatus } from "@/services/api/image";
import { parseJimengGenerationOutput } from "@/services/api/jimeng-generation";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const taskId = "c".repeat(32);
const objectId = "e63f44c2-62d9-4610-9294-6e2fa6322025";

function succeededResult(output: string): CLIHelperResult {
    return { available: true, protocol: "gpt-image-2", taskStatus: "succeeded", output, message: "success" };
}

function config(protocol: "gpt-image-2" | "codex-image-emergency" | "gemini-cli", model: "gpt-image-2" | "codex-image-emergency" | "nano-banana-2"): AiConfig {
    const provider = { id: `provider-${protocol}`, protocol, name: protocol === "gpt-image-2" ? "GPT Image 2 订阅" : protocol === "gemini-cli" ? "Antigravity CLI" : "Codex 应急生图", baseUrl: "", apiKey: "", models: [model], capabilities: ["image" as const], managed: true, enabled: true };
    return { ...defaultConfig, model, imageModel: model, imageChannelId: provider.id, activeChannelId: provider.id, localChannels: [provider] };
}

describe("subscription image controlled adapter", () => {
    afterEach(() => {
        useUserStore.setState({ token: "", user: null });
        vi.restoreAllMocks();
    });

    it.each([
        ["gpt-image-2" as const, "gpt-image-2" as const],
        ["codex-image-emergency" as const, "codex-image-emergency" as const],
        ["gemini-cli" as const, "nano-banana-2" as const],
    ])("keeps %s on its explicitly selected route", async (protocol, model) => {
        useUserStore.setState({ token: "test-token" });
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol, taskId, taskStatus: "running", message: "running" } } })
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol, taskId, taskStatus: "succeeded", output: JSON.stringify({ submitId: taskId, urls: [`/api/files/${objectId}/content`] }), message: "success" } } });

        const created = await createCanvasImageTask(config(protocol, model), "纸艺老虎", [], { source: "image-workbench" });
        const completed = await pollCanvasImageTaskStatus(created.id);

        expect(completed).toMatchObject({ status: "completed", image_url: `/api/files/${objectId}/content` });
        expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ confirmed: true, generationType: "image", model, resolution: "low" }) }));
    });

    it("accepts the exact same-origin storage proxy and rejects unsafe relative output", () => {
        expect(parseJimengGenerationOutput(succeededResult(JSON.stringify({ submitId: taskId, urls: [`/api/files/${objectId}/content`] })))).toEqual({ submitId: taskId, urls: [`/api/files/${objectId}/content`] });
        expect(parseJimengGenerationOutput(succeededResult(JSON.stringify({ submitId: taskId, urls: ["/api/files/../../private/content"] })))).toBeNull();
        expect(parseJimengGenerationOutput(succeededResult(JSON.stringify({ submitId: taskId, urls: ["http://example.test/image.png"] })))).toBeNull();
    });

    it("rejects reference images before either subscription route starts", async () => {
        useUserStore.setState({ token: "test-token" });
        const request = vi.spyOn(axios, "request");
        await expect(createCanvasImageTask(config("gpt-image-2", "gpt-image-2"), "编辑图片", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }])).rejects.toThrow("仅支持文生图");
        expect(request).not.toHaveBeenCalled();
    });
});
