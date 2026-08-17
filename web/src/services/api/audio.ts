import axios from "axios";
import { nanoid } from "nanoid";

import { audioMimeType, isGlmTtsModel, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, normalizeMimoTtsFormat, normalizeMimoTtsVoice } from "@/lib/mimo-tts";
import { resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceAudio } from "@/types/media";

export type CanvasAudioTask = {
    id: string;
    status: "queued" | "processing" | "completed" | "failed" | string;
    progress?: number;
    url?: string;
    audio_url?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    started_at?: string;
    startedAt?: string;
    created_at?: string;
    createdAt?: string;
    completed_at?: string;
    error?: { message?: string };
    error_detail?: string;
};
export type CanvasAudioTaskOptions = { nodeId?: string; sourceId?: string; clientTaskId?: string };

type MiMoAudioResponse = { choices?: Array<{ message?: { audio?: { data?: string } } }> };

function usesAccountProxy(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote" || (config.channelMode === "local" && Boolean(token));
}

function aiApiUrl(config: AiConfig, path: string) {
    if (usesAccountProxy(config)) return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote") {
        return {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
            "Content-Type": "application/json",
        };
    }
    if (token) {
        return {
            Authorization: `Bearer ${token}`,
            ...(channelIdForActiveModel(config) ? { "X-User-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
            "Content-Type": "application/json",
        };
    }
    return {
        Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`,
        "Content-Type": "application/json",
    };
}

function refreshRemoteUser(config: AiConfig) {
    if (usesAccountProxy(config)) void useUserStore.getState().hydrateUser();
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, referenceAudio?: ReferenceAudio): Promise<Blob> {
    const model = (config.model || config.audioModel).trim();
    assertAudioConfig(config, model);

    try {
        if (isMimoTtsModel(model) && !usesAccountProxy(config)) {
            const format = normalizeMimoTtsFormat(config.mimoTtsFormat);
            const body = await buildMiMoNativeRequest(config, model, prompt, referenceAudio);
            const response = await axios.post<MiMoAudioResponse>(aiApiUrl(config, "/chat/completions"), body, { headers: aiHeaders(config) });
            return decodeMiMoAudio(response.data, format);
        }

        const format = audioResponseFormat(config, model);
        const body = await buildAudioSpeechRequest(config, model, prompt, referenceAudio);
        const response = await axios.post<Blob>(aiApiUrl(config, "/audio/speech"), body, { headers: aiHeaders(config), responseType: "blob" });
        await assertAudioBlob(response.data);
        refreshRemoteUser(config);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败"));
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

export async function createCanvasAudioTask(config: AiConfig, prompt: string, options: CanvasAudioTaskOptions = {}, referenceAudio?: ReferenceAudio): Promise<CanvasAudioTask> {
    const model = (config.model || config.audioModel).trim();
    assertAudioConfig(config, model);

    if (!usesAccountProxy(config)) {
        const blob = await requestAudioGeneration(config, prompt, referenceAudio);
        const format = audioResponseFormat(config, model);
        const stored = await storeGeneratedAudio(blob, format);
        const now = new Date().toISOString();
        return {
            id: options.clientTaskId || `local_audio_task_${nanoid()}`,
            status: "completed",
            progress: 100,
            url: stored.url,
            audio_url: stored.url,
            storageKey: stored.storageKey,
            mimeType: stored.mimeType,
            bytes: stored.bytes,
            started_at: now,
            startedAt: now,
            created_at: now,
            createdAt: now,
            completed_at: now,
        };
    }

    const response = await fetch("/api/v1/canvas/audio-tasks", {
        method: "POST",
        headers: aiHeaders(config),
        body: JSON.stringify({
            endpoint: "/audio/speech",
            nodeId: options.nodeId || "",
            sourceId: options.sourceId || "",
            clientTaskId: options.clientTaskId || "",
            prompt,
            request: await buildAudioSpeechRequest(config, model, prompt, referenceAudio),
        }),
    });
    if (!response.ok) throw new Error(await readFetchError(response, "音频任务创建失败"));
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasAudioTask };
    if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "音频任务创建失败");
    refreshRemoteUser(config);
    return payload.data;
}

export async function pollCanvasAudioTaskStatus(taskId: string): Promise<CanvasAudioTask> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用云端渠道");
    const response = await fetch(`/api/v1/canvas/audio-tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(await readFetchError(response, "读取音频任务失败"));
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasAudioTask };
    if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "读取音频任务失败");
    return payload.data;
}

async function buildAudioSpeechRequest(config: AiConfig, model: string, prompt: string, referenceAudio?: ReferenceAudio) {
    if (isGlmTtsModel(model)) {
        if (prompt.length > 1024) throw new Error("GLM-TTS 文本不能超过 1024 个字符");
        return {
            model,
            input: prompt,
            voice: normalizeGlmTtsVoice(config.glmTtsVoice),
            response_format: normalizeGlmTtsFormat(config.glmTtsFormat),
            speed: Number(normalizeGlmTtsSpeed(config.glmTtsSpeed)),
        };
    }
    if (isMimoTtsModel(model)) {
        const instructions = config.audioInstructions.trim();
        return {
            model,
            input: prompt,
            ...(isMimoPresetTtsModel(model) ? { voice: normalizeMimoTtsVoice(config.mimoTtsVoice) } : {}),
            ...(isMimoVoiceDesignModel(model) ? { mimo_voice_design_prompt: config.mimoVoiceDesignPrompt.trim() } : {}),
            ...(isMimoVoiceCloneModel(model) ? { mimo_voice_clone_audio: await referenceAudioDataUrl(referenceAudio) } : {}),
            ...((isMimoPresetTtsModel(model) || isMimoVoiceCloneModel(model)) && instructions ? { instructions } : {}),
            response_format: normalizeMimoTtsFormat(config.mimoTtsFormat),
        };
    }

    const instructions = config.audioInstructions.trim();
    return {
        model,
        input: prompt,
        voice: normalizeAudioVoiceValue(config.audioVoice),
        response_format: normalizeAudioFormatValue(config.audioFormat),
        speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
        ...(instructions ? { instructions } : {}),
    };
}

function audioResponseFormat(config: AiConfig, model: string) {
    if (isGlmTtsModel(model)) return normalizeGlmTtsFormat(config.glmTtsFormat);
    if (isMimoTtsModel(model)) return normalizeMimoTtsFormat(config.mimoTtsFormat);
    return normalizeAudioFormatValue(config.audioFormat);
}

async function buildMiMoNativeRequest(config: AiConfig, model: string, prompt: string, referenceAudio?: ReferenceAudio) {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const instructions = config.audioInstructions.trim();
    if (isMimoVoiceDesignModel(model)) {
        const description = config.mimoVoiceDesignPrompt.trim();
        if (!description) throw new Error("请填写音色描述");
        messages.push({ role: "user", content: description });
    } else if (instructions && (isMimoPresetTtsModel(model) || isMimoVoiceCloneModel(model))) {
        messages.push({ role: "user", content: instructions });
    }
    messages.push({ role: "assistant", content: prompt });

    return {
        model,
        messages,
        audio: {
            format: normalizeMimoTtsFormat(config.mimoTtsFormat),
            ...(isMimoPresetTtsModel(model) ? { voice: normalizeMimoTtsVoice(config.mimoTtsVoice) } : {}),
            ...(isMimoVoiceCloneModel(model) ? { voice: await referenceAudioDataUrl(referenceAudio) } : {}),
        },
    };
}

async function referenceAudioDataUrl(referenceAudio?: ReferenceAudio) {
    if (!referenceAudio) throw new Error("请连接并选择参考音频节点");
    const url = await resolveMediaUrl(referenceAudio.storageKey, referenceAudio.url);
    if (!url) throw new Error("参考音频不可用");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取参考音频失败（${response.status}）`);
    const blob = await response.blob();
    const mimeType = normalizeCloneMimeType(blob.type) || normalizeCloneMimeType(referenceAudio.type);
    if (!mimeType) throw new Error("参考音频仅支持 MP3 或 WAV");
    const base64 = await blobToBase64(blob);
    if (base64.length > 10 * 1024 * 1024) throw new Error("参考音频 Base64 编码后不能超过 10MB");
    return `data:${mimeType};base64,${base64}`;
}

function normalizeCloneMimeType(value: string) {
    const type = value.trim().toLowerCase().split(";")[0];
    if (type === "audio/mpeg" || type === "audio/mp3") return "audio/mpeg";
    if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "audio/wav";
    return "";
}

function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取参考音频失败"));
        reader.onload = () => {
            const value = typeof reader.result === "string" ? reader.result : "";
            const separator = value.indexOf(",");
            resolve(separator >= 0 ? value.slice(separator + 1) : value);
        };
        reader.readAsDataURL(blob);
    });
}

function decodeMiMoAudio(payload: MiMoAudioResponse, format: string) {
    const data = payload.choices?.[0]?.message?.audio?.data?.trim() || "";
    if (!data) throw new Error("MiMo 没有返回音频数据");
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: audioMimeType(format) });
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (config.channelMode !== "local") return;
    if (!isMimoTtsModel(model)) {
        if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
        if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
        return;
    }
    const channel = localChannelForActiveModel(config);
    if (!(channel?.baseUrl || config.baseUrl).trim()) throw new Error("请先配置 Base URL");
    if (!(channel?.apiKey || config.apiKey).trim()) throw new Error("请先配置 API Key");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

async function readFetchError(response: Response, fallback: string) {
    try {
        const payload = (await response.json()) as { msg?: string; error?: { message?: string } };
        return payload.msg || payload.error?.message || statusMessage(response.status, fallback);
    } catch {
        return statusMessage(response.status, fallback);
    }
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
