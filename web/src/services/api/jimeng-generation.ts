import type { CLIHelperResult } from "@/lib/provider";
import { jimengModelProfile } from "@/lib/jimeng-models";
import { cancelCLIGeneration, queryCLIGeneration, startCLIGeneration } from "@/services/api/providers";
import { localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export { JIMENG_IMAGE_MODEL, JIMENG_VIDEO_MODEL } from "@/lib/jimeng-models";

export type JimengGenerationOutput = { submitId: string; urls: string[] };
export type JimengTaskReference = { providerId: string; taskId: string };

const serverStorageContentPattern = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i;

export function isJimengConfig(config: AiConfig) {
    return localChannelForActiveModel(config)?.protocol === "jimeng";
}

export async function startJimengGeneration(config: AiConfig, generationType: "image" | "video", prompt: string) {
    const channel = localChannelForActiveModel(config);
    const token = useUserStore.getState().token;
    if (!token || !channel?.id || channel.protocol !== "jimeng") throw new Error("即梦 CLI 渠道不可用，请先登录并检查连接状态");
    const model = config.model;
    const profile = jimengModelProfile(model);
    if (!profile || profile.generationType !== generationType || !channel.models.includes(model)) throw new Error("当前即梦模型不受支持");
    const result = await startCLIGeneration(token, channel.id, {
        generationType,
        model,
        prompt: prompt.trim(),
        ratio: normalizeJimengRatio(generationType === "video" ? config.videoSize || config.size : config.size, generationType),
        resolution: profile.defaultResolution,
        duration: profile.defaultDuration,
    });
    if (!result.taskId || result.taskStatus !== "running") throw new Error(result.message || "即梦任务创建失败");
    return { result, id: encodeJimengTaskReference(channel.id, result.taskId), profile };
}

export async function queryJimengGeneration(id: string) {
    const reference = parseJimengTaskReference(id);
    const token = useUserStore.getState().token;
    if (!reference || !token) throw new Error("即梦任务状态不可用，请重新登录后再试");
    return queryCLIGeneration(token, reference.providerId, reference.taskId);
}

export async function cancelJimengGeneration(id: string) {
    const reference = parseJimengTaskReference(id);
    const token = useUserStore.getState().token;
    if (!reference || !token) throw new Error("即梦任务不可取消，请重新登录后再试");
    return cancelCLIGeneration(token, reference.providerId, reference.taskId);
}

export function parseJimengGenerationOutput(result: CLIHelperResult): JimengGenerationOutput | null {
    if (result.taskStatus !== "succeeded" || !result.output) return null;
    try {
        const value = JSON.parse(result.output) as Partial<JimengGenerationOutput>;
        const urls = Array.isArray(value.urls) ? value.urls.filter((item): item is string => typeof item === "string" && (/^https:\/\//.test(item) || serverStorageContentPattern.test(item))) : [];
        return typeof value.submitId === "string" && urls.length ? { submitId: value.submitId, urls } : null;
    } catch {
        return null;
    }
}

export function encodeJimengTaskReference(providerId: string, taskId: string) {
    return `jimeng:${encodeURIComponent(providerId)}:${taskId}`;
}

export function parseJimengTaskReference(value: string): JimengTaskReference | null {
    const match = value.match(/^jimeng:([^:]+):([A-Za-z0-9_-]{32})$/);
    if (!match) return null;
    try {
        const providerId = decodeURIComponent(match[1]);
        return providerId ? { providerId, taskId: match[2] } : null;
    } catch {
        return null;
    }
}

function normalizeJimengRatio(value: string, generationType: "image" | "video") {
    const normalized = value.trim().toLowerCase().replace("x", ":");
    const supported = generationType === "video" ? ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] : ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
    if (supported.includes(normalized)) return normalized;
    const dimensions = normalized.match(/^(\d+):(\d+)$/);
    if (!dimensions) return "16:9";
    const ratio = Number(dimensions[1]) / Number(dimensions[2]);
    return ratio < 0.8 ? "9:16" : ratio < 1 ? "3:4" : ratio < 1.2 ? "1:1" : ratio < 1.5 ? "4:3" : "16:9";
}
