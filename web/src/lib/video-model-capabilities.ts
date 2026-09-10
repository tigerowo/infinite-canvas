export function modelKey(modelName: string) {
    return modelName.trim().toLowerCase().replace(/[._/]+/g, "-");
}

export function isCogVideoX3Model(modelName: string) {
    return modelKey(modelName) === "cogvideox-3";
}

export function isAgnesVideoV25Model(modelName: string) {
    return modelKey(modelName) === "agnes-video-2-5";
}

export const COGVIDEOX3_DURATIONS = ["5", "10"] as const;

export function normalizeCogVideoX3Duration(value: string) {
    const seconds = Number(value) || 5;
    return Math.abs(seconds - 5) <= Math.abs(seconds - 10) ? COGVIDEOX3_DURATIONS[0] : COGVIDEOX3_DURATIONS[1];
}

export function supportsVideoFrameReferences(modelName: string, protocol = "") {
    if (protocol === "autodl") return modelName === "minimax_h3_b99_002" || modelName === "minimax_h3_lightx2v";
    const model = modelKey(modelName);
    if (protocol === "88api") {
        return (
            model === "sd2-5 720p" ||
            model === "sd2-5 480p" ||
            model === "sd2-0 720p" ||
            model === "minimax-h3-768p" ||
            model === "seedance-2-5-720p官方版" ||
            model === "seedance-2-0-720p官方版" ||
            model === "seedance-2-0-fast-720p官方版" ||
            model === "wan3-0-video-720p" ||
            model === "wan3-0-video-1080p" ||
            model.startsWith("kling-3-0-turbo-")
        );
    }
    return (
        isAgnesVideoV25Model(model) ||
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
        model.includes("seedance-2-5") ||
        model.includes("seedance-2-0") ||
        model.includes("seedance-1-5") ||
        model.includes("seedance-1-0") ||
        model === "happyhorse-1-1" ||
        (protocol === "gemini" && (model.startsWith("veo-3-1") || model.startsWith("veo3-1"))) ||
        (model.includes("veo3-1") && model.includes("official")) ||
        model.includes("minimax-hailuo-02") ||
        model.includes("skyreels-v4") ||
        model.includes("pixverse-v6") ||
        model.includes("viduq3") ||
        model.includes("vidu-q3")
    );
}

export function supportsVideoAudioGeneration(modelName: string, protocol = "") {
    const model = modelKey(modelName);
    if (protocol === "88api") return model === "veo-3-1" || model === "veo-3-1-fast" || model === "sd2-5 480p" || model === "sd2-5 720p" || model.startsWith("kling-3-0-turbo-");
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
        model.includes("seedance-2-5") ||
        model.includes("seedance-2-0") ||
        model.includes("seedance-1-5") ||
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
