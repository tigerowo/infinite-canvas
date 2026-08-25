import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkCLIProviderAuth } from "@/services/api/providers";

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
});
