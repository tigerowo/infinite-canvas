import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCanvasImageTask, pollCanvasImageTaskStatus } from "@/services/api/image";
import { createVideoGenerationTask, pollVideoGenerationTaskStatus } from "@/services/api/video";
import { jimengModelProfiles } from "@/lib/jimeng-models";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const imageTaskId = "a".repeat(32);
const videoTaskId = "b".repeat(32);

function jimengConfig(model: string, capability: "image" | "video"): AiConfig {
    const provider = { id: "provider-jimeng", protocol: "jimeng" as const, name: "即梦 CLI", baseUrl: "", apiKey: "", models: jimengModelProfiles.map((profile) => profile.model), capabilities: ["image" as const, "video" as const], managed: true, enabled: true };
    return {
        ...defaultConfig,
        model,
        imageModel: capability === "image" ? model : defaultConfig.imageModel,
        videoModel: capability === "video" ? model : defaultConfig.videoModel,
        imageChannelId: capability === "image" ? provider.id : "",
        videoChannelId: capability === "video" ? provider.id : "",
        activeChannelId: provider.id,
        localChannels: [provider],
    };
}

describe("Jimeng controlled workbench adapter", () => {
    afterEach(() => {
        useUserStore.setState({ token: "", user: null });
        vi.restoreAllMocks();
    });

    it("routes image workbench tasks through the selected model's lowest-cost profile", async () => {
        useUserStore.setState({ token: "test-token" });
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol: "jimeng", taskId: imageTaskId, taskStatus: "running", message: "running" } } })
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol: "jimeng", taskId: imageTaskId, taskStatus: "succeeded", output: JSON.stringify({ submitId: "upstream-image", urls: ["https://cdn.example.test/image.png", "https://cdn.example.test/extra.png"] }), message: "success" } } });
        const config = jimengConfig("jimeng-image-5.0Pro", "image");

        const created = await createCanvasImageTask(config, "纸艺老虎", [], { source: "image-workbench" });
        const completed = await pollCanvasImageTaskStatus(created.id);

        expect(completed).toMatchObject({ status: "completed", image_url: "https://cdn.example.test/image.png", image_urls: ["https://cdn.example.test/image.png"] });
        expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ confirmed: true, generationType: "image", model: "jimeng-image-5.0Pro", resolution: "1.5k", duration: 0 }) }));
    });

    it("routes canvas video tasks through the selected model's lowest-cost profile", async () => {
        useUserStore.setState({ token: "test-token" });
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol: "jimeng", taskId: videoTaskId, taskStatus: "running", message: "running" } } })
            .mockResolvedValueOnce({ status: 200, data: { code: 0, data: { protocol: "jimeng", taskId: videoTaskId, taskStatus: "succeeded", output: JSON.stringify({ submitId: "upstream-video", urls: ["https://cdn.example.test/video.mp4"] }), message: "success" } } });
        const config = jimengConfig("jimeng-video-seedance2.5", "video");

        const created = await createVideoGenerationTask(config, "海边日落");
        const completed = await pollVideoGenerationTaskStatus(config, created.task);

        expect(completed).toMatchObject({ status: "succeeded", video_url: "https://cdn.example.test/video.mp4" });
        expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ confirmed: true, generationType: "video", model: "jimeng-video-seedance2.5", resolution: "480p", duration: 4 }) }));
    });

    it("rejects reference media before starting a paid CLI task", async () => {
        useUserStore.setState({ token: "test-token" });
        const request = vi.spyOn(axios, "request");
        const config = jimengConfig("jimeng-image-5.0", "image");

        await expect(createCanvasImageTask(config, "编辑图片", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }])).rejects.toThrow("仅支持文生图");
        expect(request).not.toHaveBeenCalled();
    });
});
