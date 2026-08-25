import { describe, expect, it } from "vitest";

import { parseChatImagesPayload } from "@/services/api/image";

describe("Chat image responses", () => {
    it("extracts a Markdown-embedded image Data URL", () => {
        const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
        const images = parseChatImagesPayload({ choices: [{ message: { content: `![generated image](${dataUrl})` } }] });

        expect(images).toHaveLength(1);
        expect(images[0].dataUrl).toBe(dataUrl);
    });
});
