import { imageToDataUrl } from "@/services/image-storage";
import type { VideoReferenceInput } from "@/services/api/video";

export function usesLecSeedJSON(model: string, protocol: string) {
    return protocol === "openai" && model === "lec-seed-2-0-900";
}

export async function createLecSeedRequest(model: string, prompt: string, size: string, input: Required<VideoReferenceInput>) {
    if (input.firstFrame || input.lastFrame || input.videoReferences.length || input.audioReferences.length) {
        throw new Error("该模型仅支持普通参考图片，不支持首尾帧、视频或音频参考");
    }
    if (input.references.length > 9) throw new Error("该模型最多支持 9 张参考图片");
    const images = await Promise.all(input.references.map(imageToDataUrl));
    if (images.some((image) => !image.startsWith("data:image/"))) throw new Error("参考图片读取失败");
    return {
        model,
        prompt,
        aspect_ratio: size === "9:16" || size === "720x1280" || size === "1080x1920" ? "9:16" : "16:9",
        ...(images.length ? { images } : {}),
    };
}
