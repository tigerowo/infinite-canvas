import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "@/services/image-storage";
import { newAPIImageFile } from "./request";
import { assertReferenceLimit } from "@/extensions/media-reliability/reference-limit";

type ImageParams = { n: number; size?: string; quality: string; streamPartialImages: number };

export async function createNewAPIImageBody(config: AiConfig, text: string, references: ReferenceImage[], params: ImageParams): Promise<{ endpoint: string; body: Record<string, unknown> | FormData }> {
    assertReferenceLimit(references.length);
    if (config.apiMode === "responses" || config.apiMode === "chat") {
        if (params.n > 1) throw new Error("NewAPI Chat/Responses 生图每个任务仅支持一张图片");
        const images = await Promise.all(references.map(imageToDataUrl));
        if (images.some((url) => !url)) throw new Error("无法读取参考图片");
        if (config.apiMode === "responses") return { endpoint: "/responses", body: {
            model: config.model,
            input: images.length ? [{ role: "user", content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image", image_url }))] }] : text,
            tools: [{ type: "image_generation", action: images.length ? "edit" : "generate", size: params.size || "auto", ...(params.quality !== "auto" ? { quality: params.quality } : {}), ...(config.streamImages ? { partial_images: params.streamPartialImages } : {}) }],
            tool_choice: "required", ...(config.streamImages ? { stream: true } : {}),
        } };
        return { endpoint: "/chat/completions", body: {
            model: config.model, messages: [{ role: "user", content: images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text }],
            modalities: ["image", "text"], stream: false,
        } };
    }
    const body: Record<string, unknown> = { model: config.model, prompt: text, n: params.n,
        ...(params.size ? { size: params.size } : {}), ...(params.quality !== "auto" ? { quality: params.quality } : {}),
        ...(config.responseFormatB64Json ? { response_format: "b64_json" } : {}),
        ...(config.streamImages ? { stream: true, partial_images: params.streamPartialImages } : {}),
    };
    if (!references.length) return { endpoint: "/images/generations", body };
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.set(key, String(value));
    for (const [index, image] of references.entries()) form.append(references.length === 1 ? "image" : "image[]", await newAPIImageFile(image), `reference-${index}`);
    return { endpoint: "/images/edits", body: form };
}
