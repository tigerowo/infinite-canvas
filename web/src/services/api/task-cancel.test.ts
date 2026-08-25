import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelCanvasAudioTask } from "@/services/api/audio";
import { cancelCanvasImageTask } from "@/services/api/image";
import { cancelVideoGenerationTask } from "@/services/api/video";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const remoteConfig = { ...defaultConfig, channelMode: "remote" as const };

describe("task cancellation API contracts", () => {
    beforeEach(() => {
        useUserStore.setState({ token: "test-token" });
    });

    afterEach(() => {
        useUserStore.setState({ token: "" });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("cancels an image task through the authenticated account API", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { id: "image/task", status: "cancelled" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(cancelCanvasImageTask(remoteConfig, { id: "image/task", status: "processing" })).resolves.toMatchObject({ id: "image/task", status: "cancelled" });
        expect(fetchMock).toHaveBeenCalledWith("/api/v1/canvas/image-tasks/image%2Ftask/cancel", {
            method: "POST",
            headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        });
    });

    it("rejects an unsuccessful image cancellation envelope", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 1, msg: "任务不可取消" })));

        await expect(cancelCanvasImageTask(remoteConfig, { id: "image-task", status: "processing" })).rejects.toThrow("任务不可取消");
    });

    it("cancels a video task through the authenticated account API", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { code: 0, data: { id: "video/task", status: "cancelled" } } });

        await expect(cancelVideoGenerationTask(remoteConfig, { id: "video/task", status: "running" })).resolves.toMatchObject({ id: "video/task", status: "cancelled" });
        expect(post).toHaveBeenCalledWith("/api/v1/video-tasks/video%2Ftask/cancel", null, {
            headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        });
    });

    it("rejects an unsuccessful video cancellation envelope", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { code: 1, msg: "任务不可取消" } });

        await expect(cancelVideoGenerationTask(remoteConfig, { id: "video-task", status: "running" })).rejects.toThrow("任务不可取消");
    });

    it("cancels an audio task through the authenticated account API", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { id: "audio/task", status: "cancelled" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(cancelCanvasAudioTask("audio/task")).resolves.toMatchObject({ id: "audio/task", status: "cancelled" });
        expect(fetchMock).toHaveBeenCalledWith("/api/v1/canvas/audio-tasks/audio%2Ftask/cancel", {
            method: "POST",
            headers: { Authorization: "Bearer test-token" },
        });
    });

    it("rejects an unsuccessful audio cancellation envelope", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 1, msg: "任务不可取消" })));

        await expect(cancelCanvasAudioTask("audio-task")).rejects.toThrow("任务不可取消");
    });
});
