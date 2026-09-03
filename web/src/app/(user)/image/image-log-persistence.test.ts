import { describe, expect, it, vi } from "vitest";

import { persistInlineLogImages } from "./image-log-persistence";

const inlineImage = {
    id: "image-1",
    dataUrl: "data:image/png;base64,AAAA",
    width: 10,
    height: 20,
    bytes: 3,
    mimeType: "image/png",
};

describe("image log persistence", () => {
    it("persists inline image data before saving a generation log", async () => {
        const persist = vi.fn().mockResolvedValue({ dataUrl: "blob:stored", storageKey: "image:stored", width: 10, height: 20, bytes: 3, mimeType: "image/png" });

        await expect(persistInlineLogImages([inlineImage], persist)).resolves.toEqual([{ ...inlineImage, dataUrl: "blob:stored", storageKey: "image:stored" }]);
        expect(persist).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledWith(inlineImage.dataUrl);
    });

    it("does not rewrite images that already have durable storage", async () => {
        const persist = vi.fn();
        const storedImage = { ...inlineImage, dataUrl: "blob:stored", storageKey: "image:stored" };

        await expect(persistInlineLogImages([storedImage], persist)).resolves.toBeInstanceOf(Array);
        expect(persist).not.toHaveBeenCalled();
    });
});
