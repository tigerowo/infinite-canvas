import type React from "react";
import type { AdminModelCapability, AdminModelChannel, AdminModelCost, AdminModelInfo, AdminSettings, AdminStorageProvider } from "@/services/api/admin";

// 全量 settings 空默认值，供各设置页 Form initialValues 与归一化兜底使用。
export const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            modelCosts: [],
            modelCapabilities: [],
            modelInfos: [],
            channels: [],
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            defaultAudioModel: "",
            systemPrompt: "",
            systemPrompts: { image: "", video: "", text: "", workflow: "", workflowAgent: "" },
            allowCustomChannel: true,
            allowUserRemoteChannel: false,
            allowGuestConfig: true,
        },
        auth: { allowRegister: true },
        storage: { mode: "local_indexeddb" },
    },
    private: { channels: [], promptSync: { enabled: true, cron: "0 0 * * *" }, aiLog: { localDirectReportEnabled: false, cleanup: { enabled: false, retentionDays: 14, cron: "0 3 * * *" } }, storage: { mode: "local_indexeddb", allowUserProvider: false, allowUserGlobalProvider: true, providers: [], roundRobinCursor: 0, capacityCheck: { enabled: false, cron: "0 */6 * * *" }, capacityLimitBytes: 9 * 1024 * 1024 * 1024 } },
};

export const emptyStorageProvider: AdminStorageProvider = { id: "", name: "", type: "s3", endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", publicBaseUrl: "", pathPrefix: "canvas", weight: 1, enabled: true, ownerUserId: "", capacityBytes: 0, capacityCheckedAt: "", capacityExceeded: false };

export function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    return {
        public: normalizePublicSetting(settings.public),
        private: normalizePrivateSetting(settings.private),
    };
}

export function normalizePublicSetting(setting: Partial<AdminSettings["public"]> = {}): AdminSettings["public"] {
    return {
        ...emptySettings.public,
        modelChannel: {
            ...emptySettings.public.modelChannel,
            ...(setting.modelChannel || {}),
            availableModels: setting.modelChannel?.availableModels || [],
            modelCosts: normalizeModelCosts(setting.modelChannel?.modelCosts || []),
            modelCapabilities: normalizeModelCapabilities(setting.modelChannel?.modelCapabilities || []),
            modelInfos: normalizeModelInfos(setting.modelChannel?.modelInfos || []),
            channels: setting.modelChannel?.channels || [],
            allowCustomChannel: setting.modelChannel?.allowCustomChannel !== false,
            allowUserRemoteChannel: setting.modelChannel?.allowUserRemoteChannel === true,
            allowGuestConfig: setting.modelChannel?.allowGuestConfig !== false,
            systemPrompts: {
                ...emptySettings.public.modelChannel.systemPrompts,
                image: setting.modelChannel?.systemPrompts?.image || setting.modelChannel?.systemPrompt || "",
                video: setting.modelChannel?.systemPrompts?.video || "",
                text: setting.modelChannel?.systemPrompts?.text || setting.modelChannel?.systemPrompt || "",
                workflow: setting.modelChannel?.systemPrompts?.workflow || "",
                workflowAgent: setting.modelChannel?.systemPrompts?.workflowAgent || "",
            },
        },
        auth: {
            allowRegister: setting.auth?.allowRegister !== false,
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
        },
    };
}

export function normalizeModelCosts(items: Partial<AdminSettings["public"]["modelChannel"]["modelCosts"][number]>[]) {
    return items.filter((item) => item.model).map((item) => ({ model: item.model || "", credits: Math.max(0, Number(item.credits) || 0) }));
}

export function normalizeModelInfos(items: Partial<AdminModelInfo>[]): AdminModelInfo[] {
    return items.filter((item) => item.model).map((item) => {
        const description = (item.description || "").trim();
        return { model: item.model || "", description: description.slice(0, 30) };
    });
}

export function normalizeModelCapabilities(items: Partial<AdminModelCapability>[]): AdminModelCapability[] {
    return items.filter((item) => item.model).map((item) => ({
        model: item.model || "",
        imageAspects: uniqueModels(item.imageAspects || []),
        imageTiers: uniqueModels(item.imageTiers || []) as ("standard" | "2k" | "4k")[],
        videoResolutions: uniqueModels(item.videoResolutions || []),
        videoRatios: uniqueModels(item.videoRatios || []),
        videoSecondsMin: Number(item.videoSecondsMin) || undefined,
        videoSecondsMax: Number(item.videoSecondsMax) || undefined,
        videoPanelType: item.videoPanelType || "",
        videoProvider: item.videoProvider || "",
        videoModes: (item.videoModes || []).filter((mode) => mode.value || mode.label).map((mode) => ({ value: mode.value || "", label: mode.label || "", desc: mode.desc || "" })),
        videoSecondsSmart: item.videoSecondsSmart === true,
        supportsNegativePrompt: item.supportsNegativePrompt === true,
        supportsFirstLastFrame: item.supportsFirstLastFrame === true,
        supportsFirstFrame: item.supportsFirstFrame === true,
        supportsMotionControl: item.supportsMotionControl === true,
        supportsAudioGeneration: item.supportsAudioGeneration === true,
        supportsWatermark: item.supportsWatermark === true,
        supportsMultiShot: item.supportsMultiShot === true,
        supportsElementList: item.supportsElementList === true,
        audioRequiresMode: item.audioRequiresMode || "",
        audioMaxReferences: Number(item.audioMaxReferences) || 0,
        maxImageReferences: Number(item.maxImageReferences) || 0,
        maxVideoReferences: Number(item.maxVideoReferences) || 0,
        maxAudioReferences: Number(item.maxAudioReferences) || 0,
    }));
}

export function normalizePrivateSetting(setting: Partial<AdminSettings["private"]> = {}): AdminSettings["private"] {
    return {
        channels: (setting.channels || []).map(normalizeChannel),
        promptSync: {
            enabled: setting.promptSync?.enabled !== false,
            cron: setting.promptSync?.cron || "0 0 * * *",
        },
        aiLog: {
            localDirectReportEnabled: setting.aiLog?.localDirectReportEnabled === true,
            cleanup: {
                enabled: setting.aiLog?.cleanup?.enabled === true,
                retentionDays: Number(setting.aiLog?.cleanup?.retentionDays) || 14,
                cron: setting.aiLog?.cleanup?.cron || "0 3 * * *",
            },
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
            allowUserProvider: setting.storage?.allowUserProvider === true,
            allowUserGlobalProvider: setting.storage?.allowUserGlobalProvider === true,
            providers: (setting.storage?.providers || []).map(normalizeStorageProvider),
            roundRobinCursor: Number(setting.storage?.roundRobinCursor) || 0,
            capacityCheck: {
                enabled: setting.storage?.capacityCheck?.enabled === true,
                cron: setting.storage?.capacityCheck?.cron || "0 */6 * * *",
            },
            capacityLimitBytes: Number(setting.storage?.capacityLimitBytes) || 9 * 1024 * 1024 * 1024,
        },
    };
}

export function normalizeStorageProvider(item: Partial<AdminStorageProvider> = {}): AdminStorageProvider {
    return {
        ...emptyStorageProvider,
        ...item,
        id: item.id || "",
        type: "s3",
        region: item.region || "auto",
        weight: Math.max(1, Number(item.weight) || 1),
        enabled: item.enabled !== false,
        capacityBytes: Number(item.capacityBytes) || 0,
        capacityCheckedAt: item.capacityCheckedAt || "",
        capacityExceeded: item.capacityExceeded === true,
    };
}

export function normalizeChannel(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    return {
        id: item.id || "",
        protocol: item.protocol || "openai",
        name: item.name || "",
        baseUrl: item.baseUrl || "",
        apiKey: item.apiKey || "",
        models: item.models || [],
        weight: Math.max(1, Number(item.weight) || 1),
        timeout: Math.max(1, Number(item.timeout) || 600),
        enabled: item.enabled !== false,
        remark: item.remark || "",
    };
}

export function modelCostCredits(items: AdminModelCost[], model: string) {
    return items.find((item) => item.model === model)?.credits || 0;
}

export function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminModelCost[];
    const next = current.filter((item) => item.model !== model);
    next.push({ model, credits: Math.max(0, credits) });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

export function setModelDescription(setModelInfos: React.Dispatch<React.SetStateAction<AdminModelInfo[]>>, model: string, description: string) {
    const trimmed = description.slice(0, 30);
    setModelInfos((prev) => {
        const next = prev.filter((item) => item.model !== model);
        if (trimmed) next.push({ model, description: trimmed });
        return next;
    });
}

export function modelInfoDescription(items: AdminModelInfo[], model: string) {
    return items.find((item) => item.model === model)?.description || "";
}

// 收集所有启用渠道的模型，用于「系统可用模型」多选 options。
export function collectChannelModels(channels: AdminModelChannel[]) {
    return uniqueModels(channels.filter((channel) => channel.enabled).flatMap((channel) => channel.models || []));
}

// 模型到来源渠道名的映射，用于定价表展示来源渠道。
export function collectChannelModelSources(channels: AdminModelChannel[]) {
    const map = new Map<string, string>();
    for (const channel of channels) {
        if (!channel.enabled) continue;
        const name = channel.name || "未命名";
        for (const model of channel.models || []) {
            if (!map.has(model)) map.set(model, name);
        }
    }
    return map;
}

export function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

// 把 availableModels 限定在渠道实际提供的模型集合内。
export function filterModels(models: string[], options: string[]) {
    const optionSet = new Set(options);
    return uniqueModels(models).filter((model) => optionSet.has(model));
}

export function formatStorageBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

// 保存前归一化并补齐 systemPrompt 兜底字段（后端仍读取该字段）。
export function finalizeSettingsForSave(values: AdminSettings): AdminSettings {
    const next = normalizeSettings(values);
    next.public.modelChannel.availableModels = filterModels(next.public.modelChannel.availableModels, collectChannelModels(next.private.channels));
    next.public.modelChannel.systemPrompt = next.public.modelChannel.systemPrompts.image || next.public.modelChannel.systemPrompts.text || "";
    return next;
}
