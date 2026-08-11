"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { apiGet } from "@/services/api/request";
import type { AdminModelCapability, AdminModelInfo, AdminPublicSettings, AdminVideoModeOption } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export type LocalModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
};

export type VideoMultiPromptItem = { prompt: string; duration: string };
export type VideoElementReference = { id: string; kind: "image" | "video" | "audio"; name: string; type: string; dataUrl?: string; url?: string; storageKey?: string; bytes?: number; width?: number; height?: number; durationMs?: number };
export type VideoElementItem = { name: string; description: string; references: VideoElementReference[] };

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    videoMode: string;
    videoNegativePrompt: string;
    videoMultiShot: string;
    videoShotType: string;
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoCharacterOrientation: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    videoSize: string;
    count: string;
    canvasImageCount: string;
    timeout: string;
    apiMode: string;
    streamImages: string;
    streamPartialImages: string;
    responseFormatB64Json: string;
    codexCli: string;
    systemPrompts: {
        image: string;
        video: string;
        text: string;
        workflow: string;
        workflowAgent: string;
    };
    localChannels: LocalModelChannel[];
    publicChannels: Array<{ id?: string; name?: string; baseUrl?: string; models?: string[]; weight?: number; timeout?: number; enabled?: boolean; remark?: string }>;
    modelCapabilities: AdminModelCapability[];
    modelInfos: AdminModelInfo[];
    syncModelConfig: boolean;
    syncStorageConfig: boolean;
    activeChannelId: string;
    imageChannelId: string;
    videoChannelId: string;
    textChannelId: string;
    audioChannelId: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    model: "gpt-image-2",
    imageModel: "gpt-image-2",
    videoModel: "grok-imagine-video",
    textModel: "gpt-5.5",
    audioModel: "gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    videoMode: "std",
    videoNegativePrompt: "",
    videoMultiShot: "false",
    videoShotType: "intelligence",
    videoMultiPrompt: [{ prompt: "", duration: "1" }],
    videoElementList: [{ name: "", description: "", references: [] }],
    vquality: "720",
    videoGenerateAudio: "false",
    videoWatermark: "false",
    videoCharacterOrientation: "video",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "1:1",
    videoSize: "adaptive",
    count: "1",
    canvasImageCount: "1",
    timeout: "600",
    apiMode: "images",
    streamImages: "",
    streamPartialImages: "1",
    responseFormatB64Json: "",
    codexCli: "",
    systemPrompts: {
        image: "",
        video: "",
        text: "",
        workflow: "",
        workflowAgent: "",
    },
    localChannels: [],
    publicChannels: [],
    modelCapabilities: [],
    modelInfos: [],
    syncModelConfig: false,
    syncStorageConfig: false,
    activeChannelId: "",
    imageChannelId: "",
    videoChannelId: "",
    textChannelId: "",
    audioChannelId: "",
};

type ConfigStore = {
    config: AiConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

function resolveEffectiveConfig(config: AiConfig, modelChannel: AdminPublicSettings["modelChannel"] | null, canUseRemoteChannel: boolean) {
    const channelMode = canUseRemoteChannel ? (modelChannel?.allowCustomChannel ? config.channelMode : "remote") : "local";
    if (channelMode === "local" || !modelChannel) {
        const localChannels = normalizeLocalChannels(config);
        return {
            ...config,
            channelMode,
            localChannels,
            models: normalizeModelList(localChannels.flatMap((channel) => channel.models)),
            publicChannels: modelChannel?.channels || [],
            modelCapabilities: [],
            modelInfos: [],
            apiMode: "images",
        };
    }
    const models = modelChannel.availableModels;
    const textModels = filterModelsByCapability(models, "text");
    const imageModels = filterModelsByCapability(models, "image");
    const videoModels = filterModelsByCapability(models, "video");
    const audioModels = filterModelsByCapability(models, "audio");
    const fallbackTextModel = validDefault(modelChannel.defaultTextModel, textModels) || preferredModel(textModels, isTextModelName);
    const fallbackImageModel = validDefault(modelChannel.defaultImageModel, imageModels) || preferredModel(imageModels, isImageModelName);
    const fallbackVideoModel = validDefault(modelChannel.defaultVideoModel, videoModels) || preferredModel(videoModels, isVideoModelName);
    const fallbackAudioModel = validDefault(modelChannel.defaultAudioModel, audioModels) || preferredModel(audioModels, isAudioModelName);
    const effectiveImageModel = imageModels.includes(config.imageModel) ? config.imageModel : fallbackImageModel;
    const effectiveVideoModel = videoModels.includes(config.videoModel) ? config.videoModel : fallbackVideoModel;
    const capabilities = modelChannel.modelCapabilities || [];
    const modelInfos = modelChannel.modelInfos || [];
    const imageCap = capabilities.find((item) => item.model === effectiveImageModel);
    const videoCap = capabilities.find((item) => item.model === effectiveVideoModel);
    // 生图接口模式按当前生图模型所属渠道的 apiMode 解析；找不到渠道默认 images。
    const publicChannels = modelChannel.channels || [];
    const imageChannel = publicChannels.find((channel) => channel.models?.includes(effectiveImageModel));
    const effectiveApiMode = imageChannel?.apiMode === "responses" ? "responses" : "images";
    return {
        ...config,
        channelMode,
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        model: textModels.includes(config.model) ? config.model : fallbackTextModel,
        imageModel: effectiveImageModel,
        videoModel: effectiveVideoModel,
        textModel: textModels.includes(config.textModel) ? config.textModel : fallbackTextModel,
        audioModel: audioModels.includes(config.audioModel) ? config.audioModel : fallbackAudioModel,
        systemPrompt: modelChannel.systemPrompt,
        publicChannels,
        modelCapabilities: capabilities,
        modelInfos,
        apiMode: effectiveApiMode,
        size: resolveEffectiveImageSize(config.size, imageCap),
        vquality: resolveEffectiveVideoQuality(config.vquality, videoCap),
        videoSeconds: resolveEffectiveVideoSeconds(config.videoSeconds, videoCap),
    };
}

// 视频秒数范围：未配置 = 默认 4-20；min/max 为 0 或负数视为未配置走默认。
export function resolveVideoSecondsRange(cap: AdminModelCapability | undefined): { min: number; max: number } {
    const min = cap?.videoSecondsMin && cap.videoSecondsMin > 0 ? cap.videoSecondsMin : 4;
    const max = cap?.videoSecondsMax && cap.videoSecondsMax > 0 ? cap.videoSecondsMax : 20;
    return { min: Math.min(min, max), max: Math.max(min, max) };
}

// 视频面板类型：空=通用面板；kling-v26/kling-v3/seedance/grok/motion-control/agnes。
export function resolveVideoPanelType(cap: AdminModelCapability | undefined): string {
    return cap?.videoPanelType || "";
}

// 视频厂商：空=不区分；apimart/kie。
export function resolveVideoProvider(cap: AdminModelCapability | undefined): string {
    return cap?.videoProvider || "";
}

// 视频模式选项。空=不支持模式选择。
export function resolveVideoModes(cap: AdminModelCapability | undefined): AdminVideoModeOption[] {
    return cap?.videoModes || [];
}

// 视频比例选项。空=通用面板走默认 sizeOptions。
export function resolveVideoRatios(cap: AdminModelCapability | undefined): string[] {
    return cap?.videoRatios || [];
}

// 是否支持 -1 智能时长（Seedance）。
export function resolveVideoSecondsSmart(cap: AdminModelCapability | undefined): boolean {
    return Boolean(cap?.videoSecondsSmart);
}

// 能力开关：未配置（undefined）= 走前端默认硬编码兜底；有值 = 按配置。
export function resolveSupportsNegativePrompt(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsNegativePrompt;
}
export function resolveSupportsFirstLastFrame(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsFirstLastFrame;
}
// 是否支持首帧：勾选「首尾帧」或「首帧」时均为 true（首尾帧包含首帧）。
export function resolveSupportsFirstFrame(cap: AdminModelCapability | undefined): boolean | undefined {
    if (!cap) return undefined;
    return cap.supportsFirstFrame === true || cap.supportsFirstLastFrame === true;
}
// 是否支持尾帧：仅勾选「首尾帧」时为 true（仅首帧模型不显示尾帧）。
export function resolveSupportsLastFrame(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsFirstLastFrame;
}
export function resolveSupportsMotionControl(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsMotionControl;
}
export function resolveSupportsAudioGeneration(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsAudioGeneration;
}
export function resolveSupportsWatermark(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsWatermark;
}
export function resolveSupportsMultiShot(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsMultiShot;
}
export function resolveSupportsElementList(cap: AdminModelCapability | undefined): boolean | undefined {
    return cap?.supportsElementList;
}

// 音频生成限制。
export function resolveAudioRequiresMode(cap: AdminModelCapability | undefined): string {
    return cap?.audioRequiresMode || "";
}
export function resolveAudioMaxReferences(cap: AdminModelCapability | undefined): number {
    return cap?.audioMaxReferences || 0;
}

// 参考素材数量上限（Seedance 等）。0=走前端默认硬编码（图片 9/视频 3/音频 3）。
export function resolveMaxImageReferences(cap: AdminModelCapability | undefined): number {
    return cap?.maxImageReferences || 0;
}
export function resolveMaxVideoReferences(cap: AdminModelCapability | undefined): number {
    return cap?.maxVideoReferences || 0;
}
export function resolveMaxAudioReferences(cap: AdminModelCapability | undefined): number {
    return cap?.maxAudioReferences || 0;
}

// 按模型名查找 ModelCapability。
export function findModelCapability(config: AiConfig, model: string): AdminModelCapability | undefined {
    return (config.modelCapabilities || []).find((item) => item.model === model);
}

// 切换模型时若当前秒数不在新模型范围内，回退到 min。
// 保留 -1（Seedance 智能时长）原值不动。
function resolveEffectiveVideoSeconds(seconds: string, cap: AdminModelCapability | undefined): string {
    if (String(seconds).trim() === "-1") return seconds;
    const { min, max } = resolveVideoSecondsRange(cap);
    const value = Math.floor(Number(seconds) || min);
    if (value < min || value > max) return String(min);
    return String(value);
}

// 切换模型时若当前 size 的比例不在新模型能力内，回退到 auto。
// !cap（未传能力）保持原值；cap 有值但 imageAspects 空 = 无比例可选，回退 auto。
function resolveEffectiveImageSize(size: string, cap: AdminModelCapability | undefined): string {
    if (!cap) return size;
    if (size === "auto" || /^\d+x\d+$/.test(size)) return size;
    if (!cap.imageAspects || cap.imageAspects.length === 0) return "auto";
    const aspect = size.replace(/-(2k|4k)$/, "");
    return cap.imageAspects.includes(aspect) ? size : "auto";
}

// 切换模型时若当前 vquality 不在新模型能力内，回退到第一个支持的档位。
// !cap（未传能力）保持原值；cap 有值但 videoResolutions 空 = 无档位可选，保持原值（自定义输入兜底）。
// 兼容 "720"/"720p" 和 "2k"/"2kp" 两种格式：videoResolutions 里 480p/720p/1080p 带 p，2k/4k 不带 p。
function resolveEffectiveVideoQuality(quality: string, cap: AdminModelCapability | undefined): string {
    if (!cap) return quality;
    if (!cap.videoResolutions || cap.videoResolutions.length === 0) return quality;
    const candidates = [quality, `${quality}p`];
    if (candidates.some((c) => cap.videoResolutions.includes(c))) return quality;
    return (cap.videoResolutions[0] || "720p").replace(/p$/, "");
}

function validDefault(model: string, models: string[]) {
    return models.includes(model) ? model : "";
}

function preferredModel(models: string[], predicate: (model: string) => boolean) {
    return models.find(predicate) || "";
}

function isVideoModelName(model: string) {
    const value = model.toLowerCase();
    return (
        value.includes("video") ||
        value.includes("seedance") ||
        value.includes("sora") ||
        value.includes("veo") ||
        value.includes("kling") ||
        value.includes("hailuo") ||
        value.includes("minimax") ||
        value.includes("skyreels") ||
        value.includes("happyhorse") ||
        value.includes("runway") ||
        value.includes("aleph") ||
        value.includes("vidu") ||
        value.includes("pixverse") ||
        value.includes("omni-flash") ||
        value.includes("gemini-omni-video") ||
        value.includes("veo3.1") ||
        value.includes("veo-3.1") ||
        value.includes("infinitalk") ||
        value.includes("wan2-5") ||
        value.includes("wan2.5") ||
        value.includes("wan2-6") ||
        value.includes("wan2.6") ||
        value.includes("wan2-7") ||
        value.includes("wan2.7") ||
        value.includes("wan2-7-r2v") ||
        value.includes("wan2.7-r2v") ||
        value.includes("wan2-7-videoedit") ||
        value.includes("wan2.7-videoedit") ||
        value.includes("wan/2-5") ||
        value.includes("wan/2-6") ||
        value.includes("wan/2-7-text-to-video") ||
        value.includes("wan/2-7-image-to-video") ||
        value.includes("wan/2-7-videoedit") ||
        value.includes("wan/2-7-r2v") ||
        (value.includes("grok-imagine") && (value.includes("/upscale") || value.includes("/extend")))
    );
}

function isImageModelName(model: string) {
    const value = model.toLowerCase();
    return !isVideoModelName(model) && !isAudioModelName(model) && (
        value.includes("image") ||
        value.includes("nano-banana") ||
        value.includes("seedream") ||
        value.includes("gpt-image") ||
        value.includes("dall-e") ||
        value.includes("dalle") ||
        value.includes("imagen") ||
        value.includes("gemini-2.5-flash") ||
        value.includes("gemini-3-pro") ||
        value.includes("gemini-3.1-flash") ||
        value.includes("flux") ||
        value.includes("kontext") ||
        value.includes("4o-image") ||
        value.includes("4o image") ||
        value.includes("gpt-4o-image") ||
        value.includes("z-image") ||
        value.includes("qwen/image") ||
        value.includes("qwen2/image") ||
        value.includes("qwen/text-to-image") ||
        value.includes("qwen2/text-to-image") ||
        value.includes("ideogram") ||
        value.includes("recraft") ||
        value.includes("sdxl") ||
        value.includes("stable-diffusion") ||
        value.includes("midjourney") ||
        value.includes("wan2-7-image") ||
        value.includes("wan2.7-image") ||
        value.includes("wan/2-7-image") ||
        value.includes("topaz/image") ||
        value.includes("gemini-omni-character") ||
        (value.includes("grok-imagine") && !value.includes("video"))
    );
}

function isAudioModelName(model: string) {
    const value = model.toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound") || value.includes("elevenlabs") || value.includes("suno") || value.includes("lyrics") || value.includes("vocal") || value.includes("midi") || value.includes("wav");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability)) : models;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    return filterModelsByCapability(config.models, capability);
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = localChannelForActiveModel({ ...config, model });
    return Boolean(model.trim()) && (config.channelMode === "remote" || Boolean(channel?.baseUrl.trim() && channel?.apiKey.trim()));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings") });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                const localChannels = normalizeLocalChannels(config);
                const localModels = normalizeModelList(localChannels.flatMap((channel) => channel.models));
                return {
                    ...current,
                    config: {
                        ...config,
                        localChannels,
                        models: localModels,
                        baseUrl: localChannels[0]?.baseUrl || config.baseUrl,
                        apiKey: localChannels[0]?.apiKey || config.apiKey,
                        imageChannelId: config.imageChannelId || localChannels[0]?.id || "",
                        videoChannelId: config.videoChannelId || localChannels[0]?.id || "",
                        textChannelId: config.textChannelId || localChannels[0]?.id || "",
                        audioChannelId: config.audioChannelId || localChannels[0]?.id || "",
                        activeChannelId: config.activeChannelId || "",
                        syncModelConfig: config.syncModelConfig === true,
                        syncStorageConfig: config.syncStorageConfig === true,
                        channelMode: config.channelMode || "remote",
                        imageModel: config.imageModel || config.model,
                        videoModel: config.videoModel || "grok-imagine-video",
                        textModel: config.textModel || config.model,
                        audioModel: config.audioModel || defaultConfig.audioModel,
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        systemPrompts: config.systemPrompts?.image ? config.systemPrompts : defaultConfig.systemPrompts,
                        audioInstructions: config.audioInstructions || "",
                        videoSeconds: config.videoSeconds || "6",
                        videoMode: config.videoMode || "std",
                        videoNegativePrompt: config.videoNegativePrompt || "",
                        videoMultiShot: config.videoMultiShot || "false",
                        videoShotType: config.videoShotType || "intelligence",
                        videoMultiPrompt: Array.isArray(config.videoMultiPrompt) && config.videoMultiPrompt.length ? config.videoMultiPrompt : defaultConfig.videoMultiPrompt,
                        videoElementList: Array.isArray(config.videoElementList) && config.videoElementList.length ? config.videoElementList : defaultConfig.videoElementList,
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "false",
                        videoWatermark: config.videoWatermark || "false",
                        videoCharacterOrientation: config.videoCharacterOrientation === "image" ? "image" : "video",
                        canvasImageCount: config.canvasImageCount || "1",
                        imageModels: filterModelsByCapability(localModels, "image"),
                        videoModels: filterModelsByCapability(localModels, "video"),
                        textModels: filterModelsByCapability(localModels, "text"),
                        audioModels: filterModelsByCapability(localModels, "audio"),
                        modelCapabilities: Array.isArray(config.modelCapabilities) ? config.modelCapabilities : [],
                        modelInfos: Array.isArray(config.modelInfos) ? config.modelInfos : [],
                    },
                };
            },
        },
    ),
);

function normalizeModelList(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel || null);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const canUseRemoteChannel = Boolean(token && user && (user.role === "admin" || modelChannel?.allowUserRemoteChannel === true));
    return useMemo(() => resolveEffectiveConfig(config, modelChannel, canUseRemoteChannel), [canUseRemoteChannel, config, modelChannel]);
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}

export function normalizeLocalChannels(config: Partial<AiConfig>) {
    const channels = Array.isArray(config.localChannels) ? config.localChannels : [];
    const normalized = channels.map((channel, index) => ({
        id: channel.id || `local-${index + 1}`,
        name: typeof channel.name === "string" ? channel.name : `本地渠道 ${index + 1}`,
        baseUrl: channel.baseUrl || "",
        apiKey: channel.apiKey || "",
        models: Array.isArray(channel.models) ? channel.models.filter(Boolean) : [],
    }));
    if (!normalized.length) {
        normalized.push({ id: "local-default", name: "本地直连", baseUrl: config.baseUrl || defaultConfig.baseUrl, apiKey: config.apiKey || "", models: Array.isArray(config.models) ? config.models.filter(Boolean) : [] });
    }
    return normalized;
}

export function channelIdForActiveModel(config: AiConfig) {
    if (modelMatchesCapability(config.model, "image") && config.imageChannelId) return config.imageChannelId;
    if (modelMatchesCapability(config.model, "video") && config.videoChannelId) return config.videoChannelId;
    if (modelMatchesCapability(config.model, "audio") && config.audioChannelId) return config.audioChannelId;
    if (modelMatchesCapability(config.model, "text") && config.textChannelId) return config.textChannelId;
    if (config.activeChannelId) return config.activeChannelId;
    if (config.model === config.videoModel) return config.videoChannelId;
    if (config.model === config.textModel) return config.textChannelId;
    if (config.model === config.audioModel) return config.audioChannelId;
    return config.imageChannelId;
}

export function localChannelForActiveModel(config: AiConfig) {
    const channels = normalizeLocalChannels(config);
    const preferredId = channelIdForActiveModel(config);
    return channels.find((channel) => channel.id === preferredId && channel.models.includes(config.model)) || channels.find((channel) => channel.models.includes(config.model)) || channels.find((channel) => channel.id === preferredId) || channels[0];
}

