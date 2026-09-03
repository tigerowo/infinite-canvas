import { cancelCLIGeneration, queryCLIGeneration, startCLIGeneration } from "@/services/api/providers";
import { GEMINI_CLI_IMAGE_MODEL } from "@/lib/provider";
import { modelChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export type SubscriptionImageTaskReference = { providerId: string; taskId: string };

export function isSubscriptionImageConfig(config: AiConfig) {
    const channel = modelChannelForActiveModel(config);
    return (
        (channel?.protocol === "gpt-image-2" && config.model === "gpt-image-2") ||
        (channel?.protocol === "codex-image-emergency" && config.model === "codex-image-emergency") ||
        (channel?.protocol === "gemini-cli" && config.model === GEMINI_CLI_IMAGE_MODEL) ||
        (channel?.protocol === "chatgpt-subscription-proxy" && config.model === "gpt-image-2") ||
        (channel?.protocol === "antigravity-subscription-proxy" && config.model === "gemini-3.1-flash-image")
    );
}

export async function startSubscriptionImageGeneration(config: AiConfig, prompt: string) {
    const channel = modelChannelForActiveModel(config);
    const token = useUserStore.getState().token;
    if (!token || !channel?.id || !isSubscriptionImageConfig(config)) throw new Error("本机 CLI 生图渠道不可用，请先检测 helper");
    const result = await startCLIGeneration(token, channel.id, {
        generationType: "image",
        model: config.model,
        prompt: prompt.trim(),
        ratio: normalizeSubscriptionImageRatio(config.size),
        resolution: normalizeSubscriptionImageQuality(config.quality),
        duration: 0,
    });
    if (!result.taskId || result.taskStatus !== "running") throw new Error(result.message || "本机 CLI 生图任务创建失败");
    return { result, id: encodeSubscriptionImageTaskReference(channel.id, result.taskId) };
}

export async function querySubscriptionImageGeneration(id: string) {
    const reference = parseSubscriptionImageTaskReference(id);
    const token = useUserStore.getState().token;
    if (!reference || !token) throw new Error("订阅生图任务状态不可用，请重新登录后再试");
    return queryCLIGeneration(token, reference.providerId, reference.taskId);
}

export async function cancelSubscriptionImageGeneration(id: string) {
    const reference = parseSubscriptionImageTaskReference(id);
    const token = useUserStore.getState().token;
    if (!reference || !token) throw new Error("订阅生图任务不可取消，请重新登录后再试");
    return cancelCLIGeneration(token, reference.providerId, reference.taskId);
}

export function encodeSubscriptionImageTaskReference(providerId: string, taskId: string) {
    return `subscription-image:${encodeURIComponent(providerId)}:${taskId}`;
}

export function parseSubscriptionImageTaskReference(value: string): SubscriptionImageTaskReference | null {
    const match = value.match(/^subscription-image:([^:]+):([A-Za-z0-9_-]{32})$/);
    if (!match) return null;
    try {
        const providerId = decodeURIComponent(match[1]);
        return providerId ? { providerId, taskId: match[2] } : null;
    } catch {
        return null;
    }
}

function normalizeSubscriptionImageRatio(value: string) {
    const normalized = value.trim().toLowerCase().replace("x", ":");
    if (["1:1", "2048:2048"].includes(normalized)) return "1:1";
    if (["21:9", "16:9", "3:2", "4:3", "3136:1344", "6272:2688", "2048:1152", "3840:2160"].includes(normalized)) return "3:2";
    if (["9:16", "2:3", "3:4", "1152:2048", "2160:3840"].includes(normalized)) return "2:3";
    const dimensions = normalized.match(/^(\d+):(\d+)$/);
    if (dimensions) {
        const width = Number(dimensions[1]);
        const height = Number(dimensions[2]);
        if (width > height) return "3:2";
        if (height > width) return "2:3";
    }
    return "1:1";
}

function normalizeSubscriptionImageQuality(value: string) {
    const normalized = value.trim().toLowerCase();
    if (["medium", "2k"].includes(normalized)) return "medium";
    if (["high", "hd", "4k"].includes(normalized)) return "high";
    return "low";
}
