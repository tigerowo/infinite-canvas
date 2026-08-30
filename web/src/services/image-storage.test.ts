import { describe, expect, it } from "vitest";

import { getProxyUrl } from "@/services/image-storage";

describe("remote media proxy routing", () => {
    it("routes media through the dedicated bounded media proxy", () => {
        expect(getProxyUrl("https://cdn.example.com/video.mp4", "/api/proxy-media")).toBe(
            "/api/proxy-media?url=https%3A%2F%2Fcdn.example.com%2Fvideo.mp4",
        );
    });

    it("keeps non-http inputs unchanged", () => {
        expect(getProxyUrl("blob:video", "/api/proxy-media")).toBe("blob:video");
    });
});
