export function modelKey(modelName: string) {
    return modelName.trim().toLowerCase().replace(/[._/]+/g, "-");
}

export function isCogVideoX3Model(modelName: string) {
    return modelKey(modelName) === "cogvideox-3";
}

export const COGVIDEOX3_DURATIONS = ["5", "10"] as const;

export function normalizeCogVideoX3Duration(value: string) {
    const seconds = Number(value) || 5;
    return Math.abs(seconds - 5) <= Math.abs(seconds - 10) ? COGVIDEOX3_DURATIONS[0] : COGVIDEOX3_DURATIONS[1];
}

export function supportsVideoFrameReferences(modelName: string) {
    const model = modelKey(modelName);
    return (
        isCogVideoX3Model(model) ||
        model === "bytedance-seedance-2" ||
        model === "bytedance-seedance-2-fast" ||
        model === "bytedance-seedance-2-mini" ||
        model === "bytedance-seedance-2-5" ||
        model === "wan-2-7-image-to-video" ||
        model === "bytedance-v1-lite-image-to-video" ||
        model === "hailuo-02-image-to-video-standard" ||
        model === "hailuo-02-image-to-video-pro" ||
        model === "kling-v2-1-pro" ||
        model === "kling-v2-5-turbo-image-to-video-pro" ||
        model === "minimax-h3-image-to-video" ||
        model === "minimax-h3" ||
        model.includes("doubao-seedance-2-5") ||
        model.includes("doubao-seedance-2-0") ||
        model.includes("doubao-seedance-1-5") ||
        model.includes("doubao-seedance-1-0") ||
        model === "happyhorse-1-1" ||
        (model.includes("veo3-1") && model.includes("official")) ||
        model.includes("minimax-hailuo-02") ||
        model.includes("skyreels-v4") ||
        model.includes("pixverse-v6") ||
        model.includes("viduq3") ||
        model.includes("vidu-q3")
    );
}

export function supportsVideoAudioGeneration(modelName: string) {
    const model = modelKey(modelName);
    if (model.includes("motion-control")) return false;
    return (
        isCogVideoX3Model(model) ||
        model === "kling-2-6-text-to-video" ||
        model === "kling-2-6-image-to-video" ||
        model === "kling-text-to-video" ||
        model === "kling-image-to-video" ||
        model === "bytedance-seedance-2" ||
        model === "bytedance-seedance-2-fast" ||
        model === "bytedance-seedance-2-mini" ||
        model === "bytedance-seedance-2-5" ||
        model === "wan-2-6-flash-image-to-video" ||
        model === "wan-2-6-flash-video-to-video" ||
        model.includes("bytedance-seedance-1-5") ||
        model.includes("doubao-seedance-2-5") ||
        model.includes("doubao-seedance-2-0") ||
        model.includes("doubao-seedance-1-5") ||
        (model.includes("veo") && model.includes("official")) ||
        model === "wan2-6" ||
        model === "wan2-6-i2v-flash" ||
        model.includes("kling-v2-6") ||
        model.includes("kling-2-6") ||
        ((model.includes("kling-v3") || model.includes("kling-3-0")) && !model.includes("turbo")) ||
        model.includes("pixverse-v6") ||
        model.includes("viduq3-pro") ||
        model.includes("vidu-q3-pro") ||
        model.includes("viduq3-turbo")
    );
}
