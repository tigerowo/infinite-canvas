import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelCLIModelProbe, checkCLIProviderAuth, queryCLIModelProbe, startCLICompletion, startCLIModelProbe, startCLIProviderLogin } from "@/services/api/providers";

describe("CLI provider auth status API contract", () => {
    afterEach(() => vi.restoreAllMocks());

    it("requests a separately authorized read-only auth status action", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({
            status: 200,
            data: { code: 0, data: { available: true, protocol: "codex", authStatus: "authenticated", message: "Codex CLI 已登录" }, msg: "" },
        });

        await expect(checkCLIProviderAuth("test-token", "provider/id")).resolves.toMatchObject({ authStatus: "authenticated" });
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "/api/v1/providers/provider%2Fid/cli/auth-status",
                method: "POST",
                data: {},
                headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
            }),
        );
    });

    it("starts the separately confirmed browser login action", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({
            status: 200,
            data: { code: 0, data: { available: true, protocol: "codex", actionStatus: "started", message: "Codex 登录已启动" }, msg: "" },
        });

        await expect(startCLIProviderLogin("test-token", "provider/id")).resolves.toMatchObject({ actionStatus: "started" });
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "/api/v1/providers/provider%2Fid/cli/login",
                method: "POST",
                data: { confirmed: true },
                headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
            }),
        );
    });

    it("starts, polls, and cancels a separately confirmed model probe", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({
            status: 200,
            data: { code: 0, data: { available: true, protocol: "codex", taskId: "task/id", taskStatus: "running", message: "Codex 最小调用正在执行" }, msg: "" },
        });

        await expect(startCLIModelProbe("test-token", "provider/id")).resolves.toMatchObject({ taskStatus: "running" });
        await queryCLIModelProbe("test-token", "provider/id", "task/id");
        await cancelCLIModelProbe("test-token", "provider/id", "task/id");
        expect(request).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ url: "/api/v1/providers/provider%2Fid/cli/model-probe", method: "POST", data: { confirmed: true } }),
        );
        expect(request).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ url: "/api/v1/providers/provider%2Fid/cli/model-probe/task%2Fid/status", method: "POST", data: {} }),
        );
        expect(request).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({ url: "/api/v1/providers/provider%2Fid/cli/model-probe/task%2Fid/cancel", method: "POST", data: {} }),
        );
    });

    it("starts a controlled Antigravity canvas completion without command fields", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({
            status: 200,
            data: { code: 0, data: { available: true, protocol: "gemini-cli", taskId: "task-id", taskStatus: "running", message: "Antigravity CLI 调用正在执行" }, msg: "" },
        });

        await startCLICompletion("test-token", "provider/id", "gemini-3.5-flash-low", "canvas prompt");
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "/api/v1/providers/provider%2Fid/cli/completions",
                method: "POST",
                data: { model: "gemini-3.5-flash-low", prompt: "canvas prompt" },
                headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
            }),
        );
    });
});
