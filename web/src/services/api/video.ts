import axios from "axios";

import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { isMiniMaxH3Config, normalizeMiniMaxH3Duration, normalizeMiniMaxH3Ratio, normalizeMiniMaxH3Resolution } from "@/lib/minimax-video";
import { dataUrlToGeminiInlineData, geminiActionUrl, geminiDirectHeaders, geminiErrorMessage, geminiOperationUrl, isGeminiConfig, isGeminiVideoModel } from "@/lib/gemini";
import { isGeminiVeo31Model, normalizeGeminiVideoDuration, normalizeGeminiVideoRatio, normalizeGeminiVideoResolution } from "@/lib/gemini-video";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceRatio } from "@/lib/seedance-video";
import { isKIEGrokVideoModel, isKIEKlingV3Config, kieKlingOmniVariant } from "@/components/video-settings-panel";
import { isAgnesVideoV25Model, isCogVideoX3Model, modelKey, normalizeCogVideoX3Duration, supportsVideoAudioGeneration } from "@/lib/video-model-capabilities";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, channelProtocolForConfig, directAIProviderForConfig, localChannelForActiveModel, modelChannelHeaders, type AiConfig, type VideoElementReference } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type VideoResponse = { id: string; task_id?: string; video_id?: string; source_id?: string; sourceId?: string; channelId?: string; userChannelId?: string; channelName?: string; channel_id?: string; user_channel_id?: string; channel_name?: string; status?: string; video_url?: string; url?: string; storageKey?: string; progress?: number; error?: { message?: string }; size?: string; seconds?: string; model?: string; created_at?: string | number; createdAt?: string | number; started_at?: string | number; startedAt?: string | number; request_body?: string };
type ApiVideoEnvelope = { code: number; data?: VideoResponse | VideoResponse[] | null; msg?: string; message?: string };
type ApiVideoResponse = VideoResponse | ApiVideoEnvelope;
export type VideoGenerationResult = { id: string; url: string; durationMs: number; width: number; height: number; bytes: number; mimeType: string; task: VideoResponse };
export type CreatedVideoGenerationTask = { task: VideoResponse; pollId: string; startedAt: number; requestBody: unknown };
export type VideoProgressHandler = (progress: number, task: VideoResponse) => void;
export type VideoTaskCreateOptions = { clientTaskId?: string; source?: "video-workbench" | "canvas"; sourceId?: string };
export const VIDEO_POLL_INTERVAL_MS = 5000;

export class VideoRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "VideoRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

function usesAccountProxy(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote" || (config.channelMode === "local" && Boolean(token));
}

function aiApiUrl(config: AiConfig, path: string) {
    if (usesAccountProxy(config)) return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiVideoPollUrl(config: AiConfig, model: string, id: string) {
    if (!usesAccountProxy(config) && isGeminiConfig(config, model)) {
        const channel = localChannelForActiveModel(config);
        return geminiOperationUrl(channel?.baseUrl || config.baseUrl, id);
    }
    if (!usesAccountProxy(config) && isMiniMaxH3Config(config, model)) {
        return miniMaxApiUrl(config, `/v2/query/video_generation/${encodeURIComponent(id)}`);
    }
    if (!usesAccountProxy(config) && isCogVideoX3Model(model)) {
        return aiApiUrl(config, `/async-result/${encodeURIComponent(id)}`);
    }
    if (!isAgnesVideoModel(model) || !id.startsWith("video_")) {
        return aiApiUrl(config, `/videos/${encodeURIComponent(id)}`);
    }
    if (usesAccountProxy(config)) {
        return `/api/v1/videos/${encodeURIComponent(id)}`;
    }
    const channel = localChannelForActiveModel(config);
    const baseUrl = agnesBaseUrl(channel?.baseUrl || config.baseUrl);
    return `${baseUrl}/agnesapi?video_id=${encodeURIComponent(id)}&model_name=${encodeURIComponent(model)}`;
}

function miniMaxApiUrl(config: AiConfig, path: string) {
    const channel = localChannelForActiveModel(config);
    return `${(channel?.baseUrl || config.baseUrl).trim().replace(/\/+$/, "")}${path}`;
}

function agnesBaseUrl(baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    return normalized.toLowerCase().endsWith("/v1") ? normalized.slice(0, -3).replace(/\/+$/, "") : normalized;
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    if (config.channelMode === "remote") return { Authorization: `Bearer ${token}`, ...modelChannelHeaders(config) };
    if (token) return { Authorization: `Bearer ${token}`, ...modelChannelHeaders(config) };
    if (isGeminiConfig(config)) return geminiDirectHeaders(config);
    return { Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}` };
}

function refreshRemoteUser(config: AiConfig) {
    if (usesAccountProxy(config)) void useUserStore.getState().hydrateUser();
}

export type VideoReferenceInput = {
    references?: ReferenceImage[];
    videoReferences?: ReferenceVideo[];
    audioReferences?: ReferenceAudio[];
    firstFrame?: ReferenceImage | null;
    lastFrame?: ReferenceImage | null;
};

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] | VideoReferenceInput = [], videoReferencesOrProgress?: ReferenceVideo[] | ((progress: number) => void), audioReferences: ReferenceAudio[] = []) {
    const legacyVideoReferences = Array.isArray(videoReferencesOrProgress) ? videoReferencesOrProgress : undefined;
    const onProgress = typeof videoReferencesOrProgress === "function" ? videoReferencesOrProgress : undefined;
    const input = legacyVideoReferences ? { references: Array.isArray(references) ? references : references.references || [], videoReferences: legacyVideoReferences, audioReferences } : references;
    const created = await createVideoGenerationTask(config, prompt, input, onProgress ? (progress) => onProgress(progress) : undefined);
    return pollCreatedVideoGenerationTask(config, created.task, { startedAt: created.startedAt, requestBody: created.requestBody, onProgress: onProgress ? (progress) => onProgress(progress) : undefined });
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] | VideoReferenceInput = [], onProgress?: VideoProgressHandler, options?: string | VideoTaskCreateOptions): Promise<CreatedVideoGenerationTask> {
    const model = config.model || config.videoModel;
    const systemPrompt = (config.systemPrompts.video || config.systemPrompt).trim();
    const body = await createVideoRequestBody(config, model, systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, normalizeVideoReferenceInput(references));
    const startedAt = Date.now();
    try {
        const createOptions = normalizeVideoTaskCreateOptions(options);
        const accountProxy = usesAccountProxy(config);
        const headers = { ...aiHeaders(config), ...(accountProxy && createOptions.clientTaskId ? { "X-Client-Video-Task-ID": createOptions.clientTaskId } : {}), ...(accountProxy && createOptions.source ? { "X-Video-Task-Source": createOptions.source } : {}), ...(accountProxy && createOptions.sourceId ? { "X-Video-Task-Source-ID": createOptions.sourceId } : {}) };
        const directProvider = !accountProxy ? directAIProviderForConfig(config) : null;
        const channel = localChannelForActiveModel(config);
        const createUrl = !accountProxy && isGeminiConfig(config, model)
            ? geminiActionUrl(channel?.baseUrl || config.baseUrl, model, "predictLongRunning")
            : !accountProxy && isMiniMaxH3Config(config, model)
                ? miniMaxApiUrl(config, "/v2/video_generation")
                : aiApiUrl(config, !accountProxy && (isGrok2APIVideoConfig(config, model) || isCogVideoX3Model(model)) ? "/videos/generations" : "/videos");
        const requestBody = !accountProxy && isGeminiConfig(config, model) ? withoutVideoModel(body) : body;
        const created = directProvider
            ? await (await import("@/services/api/direct-ai")).createDirectVideoTask(config, directProvider, body)
            : unwrapVideoResponseForConfig(config, model, (await axios.post<ApiVideoResponse>(createUrl, requestBody, { headers })).data);
        if (!created.id && !created.video_id) throw new Error("视频接口没有返回任务 ID");
        if (typeof created.progress === "number") onProgress?.(created.progress, created);
        return { task: created, pollId: videoPollId(model, created), startedAt, requestBody: body };
    } catch (error) {
        const { message, detail } = readAxiosError(error, "视频生成失败");
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, axios.isAxiosError(error) ? error.response?.status || 0 : 0, stringifyLogPayload(summarizeVideoRequestBody(body)), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

function normalizeVideoTaskCreateOptions(options?: string | VideoTaskCreateOptions): VideoTaskCreateOptions {
    return typeof options === "string" ? { clientTaskId: options } : options || {};
}

export async function pollCreatedVideoGenerationTask(config: AiConfig, task: VideoResponse, { startedAt = Date.now(), requestBody, initialDelayMs = 0, onProgress, onPoll }: { startedAt?: number; requestBody?: unknown; initialDelayMs?: number; onProgress?: VideoProgressHandler; onPoll?: (task: VideoResponse) => void } = {}) {
    const model = config.model || config.videoModel;
    const pollId = videoPollId(model, task);
    if (!pollId) throw new VideoRequestError("视频接口没有返回任务 ID", task);
    const directProvider = !usesAccountProxy(config) ? directAIProviderForConfig(config) : null;
    const directPoll = directProvider ? (await import("@/services/api/direct-ai")).pollDirectVideoTask : null;
    const pollOnce = directProvider && directPoll
        ? () => directPoll(config, directProvider, pollId)
        : async () => unwrapVideoResponseForConfig(config, model, (await axios.get<ApiVideoResponse>(aiVideoPollUrl(config, model, pollId), { headers: aiHeaders(config), params: usesAccountProxy(config) ? { model } : undefined })).data);
    let completed: VideoResponse | null = null;
    try {
        if (initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
        for (; ;) {
            const video = await cacheProtectedGeminiVideo(config, model, await pollOnce());
            onPoll?.(video);
            if (isFailedVideoStatus(video.status)) throw new VideoRequestError(video.error?.message || "视频生成失败", video);
            if (typeof video.progress === "number") onProgress?.(video.progress, video);
            if (isCompletedVideoStatus(video.status) || video.video_url || video.url) {
                completed = video;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
        }
        const videoUrl = completed?.video_url || completed?.url || "";
        if (!videoUrl) throw new VideoRequestError("视频生成完成但没有返回视频地址", completed);
        const result = buildVideoGenerationResult(completed, videoUrl, Date.now() - startedAt);
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, 200, stringifyLogPayload(requestBody ? summarizeVideoRequestBody(requestBody) : { taskId: pollId }), stringifyLogPayload({ task: completed, video: result }), "");
        refreshRemoteUser(config);
        return result;
    } catch (error) {
        const { message, detail } = readAxiosError(error, "视频生成失败");
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, axios.isAxiosError(error) ? error.response?.status || 0 : 0, stringifyLogPayload(requestBody ? summarizeVideoRequestBody(requestBody) : { taskId: pollId }), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

export async function pollVideoGenerationTaskStatus(config: AiConfig, task: VideoResponse) {
    const model = config.model || config.videoModel;
    const pollId = videoPollId(model, task);
    if (!pollId) throw new VideoRequestError("视频接口没有返回任务 ID", task);
    const directProvider = !usesAccountProxy(config) ? directAIProviderForConfig(config) : null;
    const result = directProvider
        ? await (await import("@/services/api/direct-ai")).pollDirectVideoTask(config, directProvider, pollId)
        : unwrapVideoResponseForConfig(config, model, (await axios.get<ApiVideoResponse>(aiVideoPollUrl(config, model, pollId), { headers: aiHeaders(config), params: usesAccountProxy(config) ? { model } : undefined })).data);
    return cacheProtectedGeminiVideo(config, model, await cacheProtectedGrokVideo(config, model, result));
}

export async function listVideoGenerationTasks(config: AiConfig) {
    if (!usesAccountProxy(config)) return [];
    const payload = (await axios.get<ApiVideoEnvelope>("/api/v1/video-tasks", { headers: aiHeaders(config) })).data;
    if (payload.code !== 0) throw new VideoRequestError(payload.msg || payload.message || "读取视频任务失败", payload);
    return Array.isArray(payload.data) ? payload.data.map(normalizeVideoResponse) : [];
}

export async function deleteVideoGenerationTask(config: AiConfig, task?: VideoResponse | null) {
    if (!usesAccountProxy(config) || !task) return;
    const id = task.id || task.task_id || task.video_id;
    if (!id) return;
    const payload = (await axios.delete<ApiVideoEnvelope>(`/api/v1/video-tasks/${encodeURIComponent(id)}`, { headers: aiHeaders(config) })).data;
    if (payload.code !== 0) throw new VideoRequestError(payload.msg || payload.message || "删除视频任务失败", payload);
}

export async function cancelVideoGenerationTask(config: AiConfig, task?: VideoResponse | null) {
    if (!usesAccountProxy(config) || !task) return task || null;
    const id = task.id || task.task_id || task.video_id;
    if (!id) return task;
    const payload = (await axios.post<ApiVideoEnvelope>(`/api/v1/video-tasks/${encodeURIComponent(id)}/cancel`, null, { headers: aiHeaders(config) })).data;
    if (payload.code !== 0 || !payload.data || Array.isArray(payload.data)) throw new VideoRequestError(payload.msg || payload.message || "取消视频任务失败", payload);
    return normalizeVideoResponse(payload.data);
}

function isGrok2APIVideoConfig(config: AiConfig, model: string) {
    const normalizedModel = model.trim().toLowerCase();
    return (normalizedModel === "grok-imagine-video" || normalizedModel === "grok-imagine-video-1.5") && videoChannelProtocol(config, model) === "grok2api";
}

async function cacheProtectedGrokVideo(config: AiConfig, model: string, task: VideoResponse) {
    const url = task.video_url || task.url || "";
    if (!isCompletedVideoStatus(task.status) || task.storageKey || !isGrok2APIVideoConfig(config, model) || !/\/v1\/videos\/[^/]+\/content(?:[?#]|$)/.test(url)) return task;
    const taskId = task.task_id || task.id || task.video_id || "";
    const response = await fetch(`${aiApiUrl(config, `/videos/${encodeURIComponent(taskId)}/content`)}?model=${encodeURIComponent(model)}`, { headers: aiHeaders(config) });
    if (!response.ok) throw new VideoRequestError(`视频内容下载失败：${response.status}`, task);
    const media = await uploadMediaFile(await response.blob(), "generated-video");
    return { ...task, url: media.url, video_url: media.url, storageKey: media.storageKey };
}

async function createGrok2APIVideoRequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    const body: Record<string, unknown> = {
        model,
        prompt,
        duration: Number(normalizeVideoSeconds(config.videoSeconds)),
        resolution: normalizeVideoResolution(config.vquality),
    };
    const aspectRatio = normalizeSeedanceRatio(config.size);
    if (aspectRatio !== "adaptive") body.aspect_ratio = aspectRatio;

    const urls = await Promise.all(input.references.map((reference) => imageToDataUrl(reference)));
    if (urls.length === 1) body.image = { url: urls[0] };
    else if (urls.length > 1) body.reference_images = urls.map((url) => ({ url }));

    return body;
}

async function createAgnesVideoV25RequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    const hasFrames = Boolean(input.firstFrame || input.lastFrame);
    const hasReferences = Boolean(input.references.length || input.videoReferences.length || input.audioReferences.length);
    if (hasFrames && hasReferences) throw new VideoRequestError("Agnes Video 2.5 的首尾帧不能和普通参考素材同时使用");

    const ratio = normalizeSeedanceRatio(config.size);
    const body: Record<string, unknown> = {
        model,
        prompt,
        mode: hasFrames ? "keyframe" : hasReferences ? "reference" : "text",
        seconds: String(Math.min(12, Math.max(4, Math.floor(Number(config.videoSeconds) || 5)))),
        size: "720P",
        aspect_ratio: ratio === "adaptive" ? "16:9" : ratio,
    };
    if (input.firstFrame) body.first_frame = await agnesVideoV25ReferenceUrl(input.firstFrame);
    if (input.lastFrame) body.last_frame = await agnesVideoV25ReferenceUrl(input.lastFrame);
    if (input.references.length) body.images = await Promise.all(input.references.map(agnesVideoV25ReferenceUrl));
    if (input.audioReferences.length) body.audios = await Promise.all(input.audioReferences.map(agnesVideoV25ReferenceUrl));
    if (input.videoReferences.length) {
        const urls = await Promise.all(input.videoReferences.map(agnesVideoV25ReferenceUrl));
        body.videos = urls.map((url) => ({ url }));
    }
    return body;
}

async function createVideoRequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    const size = normalizeVideoSize(config.size);
    if (isGeminiVideoModel(model) && isGeminiConfig(config, model)) return createGeminiVeoRequestBody(config, model, prompt, input);
    if (isGrok2APIVideoConfig(config, model)) return createGrok2APIVideoRequestBody(config, model, prompt, input);
    if (isMiniMaxH3Config(config, model)) return createMiniMaxH3VideoRequestBody(config, model, prompt, input);
    if (isCogVideoX3Model(model)) return createCogVideoX3RequestBody(config, model, prompt, input);
    if (isAgnesVideoV25Model(model)) return createAgnesVideoV25RequestBody(config, model, prompt, input);
    if (isAgnesVideoModel(model)) {
        const references = input.references;
        const inputReferences = await Promise.all(references.slice(0, 7).map(imageToAgnesReference));
        const dimensions = size ? parseVideoDimensions(size) : null;
        const frameRate = agnesFrameRate(config.videoSeconds);
        const body: Record<string, unknown> = {
            model,
            prompt,
            num_frames: agnesNumFrames(config.videoSeconds, frameRate),
            frame_rate: frameRate,
        };
        if (dimensions) {
            body.width = dimensions.width;
            body.height = dimensions.height;
        }
        if (inputReferences.length === 1) body.image = inputReferences[0];
        if (inputReferences.length > 1) body.extra_body = { image: inputReferences, mode: "keyframes" };
        return body;
    }

    const klingV26 = isAPIMartKlingV26VideoConfig(config, model);
    const apimartKlingV3 = isAPIMartKlingV3VideoConfig(config, model);
    const apimartMotionControl = isAPIMartKlingMotionControlVideoConfig(config, model);
    const kieKlingV3 = isKIEKlingV3Config(config, model);
    const kieKlingOmni = kieKlingOmniVariant(config, model);
    const kieMotionControl = isKIEKlingMotionControlVideoConfig(config, model);
    const motionControl = apimartMotionControl || kieMotionControl;
    const klingV3 = apimartKlingV3 || kieKlingV3;
    const kling = klingV26 || klingV3;
    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    if (kling) {
        body.append("mode", klingV3 ? normalizeKlingV3Mode(config.videoMode) : normalizeKlingV26Mode(config.videoMode));
        body.append("duration", klingV3 ? normalizeKlingV3Duration(config.videoSeconds) : normalizeKlingV26Duration(config.videoSeconds));
        body.append("aspect_ratio", normalizeKlingV26AspectRatio(config.size));
        if (!kieKlingV3 && config.videoNegativePrompt?.trim()) body.append("negative_prompt", config.videoNegativePrompt.trim());
        if (klingV3 && kieKlingOmni !== "transformation" && boolConfig(config.videoMultiShot, false)) {
            body.append("multi_shot", "true");
            const supportsSmartShots = !kieKlingV3 || kieKlingOmni === "text-to-video" || kieKlingOmni === "image-to-video";
            if (!supportsSmartShots) {
                body.append("multi_prompt", JSON.stringify(normalizeKIEKlingMultiPrompt(config.videoMultiPrompt)));
            } else {
                const shotType = normalizeKlingShotType(config.videoShotType);
                body.append("shot_type", shotType);
                if (shotType === "customize") body.append("multi_prompt", JSON.stringify(kieKlingV3 ? normalizeKIEKlingMultiPrompt(config.videoMultiPrompt) : normalizeKlingMultiPrompt(config.videoMultiPrompt)));
            }
        }
        if (klingV3 && kieKlingOmni !== "transformation") {
            const elementList = await (kieKlingV3 ? normalizeKIEKlingElementList(config.videoElementList) : normalizeKlingElementList(config.videoElementList));
            if (elementList.length) body.append("element_list", JSON.stringify(elementList));
        }
    } else if (apimartMotionControl) {
        body.append("mode", normalizeAPIMartKlingMotionControlMode(config.vquality));
    } else {
        if (!kieMotionControl && !isGeminiOmniFlashVideoModel(model)) body.append("seconds", normalizeVideoSecondsForModel(model, config.videoSeconds));
        if (isSeedanceVideoConfig(config)) body.append("size", normalizeSeedanceRatio(config.size));
        else if (size) body.append("size", size);
        body.append("resolution_name", normalizeVideoResolution(config.vquality));
        if (isKIEGrokVideoModel(config, model)) body.append("mode", normalizeGrokVideoMode(config.videoMode));
        else body.append("preset", "normal");
    }
    if (motionControl) body.append("character_orientation", normalizeCharacterOrientation(config.videoCharacterOrientation));
    if (supportsVideoAudioGeneration(model)) body.append("video_generate_audio", String(boolConfig(config.videoGenerateAudio, false)));
    const imageReferenceLimit = kieKlingOmni === "text-to-video" ? 0 : kieKlingOmni === "reference-to-video" ? input.references.length : kieKlingOmni === "transformation" ? 4 : kling ? 2 : 9;
    const files = await Promise.all(input.references.slice(0, imageReferenceLimit).map(imageReferenceToFormValue));
    files.forEach((file) => body.append("input_reference[]", file));
    if (!kling && input.firstFrame) body.append("first_frame_url", await imageReferenceToFormValue(input.firstFrame));
    if (!kling && input.lastFrame) body.append("last_frame_url", await imageReferenceToFormValue(input.lastFrame));
    const videoFiles = kling && kieKlingOmni !== "reference-to-video" && kieKlingOmni !== "transformation" ? [] : await Promise.all(input.videoReferences.slice(0, kieKlingOmni ? 1 : input.videoReferences.length).map(mediaReferenceToFormValue));
    videoFiles.forEach((file) => body.append("video_reference[]", file));
    const audioFiles = kling ? [] : await Promise.all(input.audioReferences.map(mediaReferenceToFormValue));
    audioFiles.forEach((file) => body.append("audio_reference[]", file));
    return body;
}

async function createMiniMaxH3VideoRequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    const hasFrames = Boolean(input.firstFrame || input.lastFrame);
    const hasReferences = Boolean(input.references.length || input.videoReferences.length || input.audioReferences.length);
    if (hasFrames && hasReferences) throw new VideoRequestError("MiniMax-H3 首尾帧不能与参考图片、视频或音频同时使用");
    if (input.audioReferences.length && !input.references.length && !input.videoReferences.length) {
        throw new VideoRequestError("MiniMax-H3 参考音频需要同时提供参考图片或参考视频");
    }

    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (hasFrames) {
        const frames = [
            { reference: input.firstFrame, role: "first_frame" },
            { reference: input.lastFrame, role: "last_frame" },
        ].filter((item): item is { reference: ReferenceImage; role: string } => Boolean(item.reference));
        const urls = await Promise.all(frames.map((item) => miniMaxReferenceValue(imageReferenceToFormValue(item.reference))));
        frames.forEach((item, index) => content.push({ type: "image_url", image_url: { url: urls[index] }, role: item.role }));
    } else if (hasReferences) {
        const [images, videos, audios] = await Promise.all([
            Promise.all(input.references.map((reference) => miniMaxReferenceValue(imageReferenceToFormValue(reference)))),
            Promise.all(input.videoReferences.map((reference) => miniMaxReferenceValue(mediaReferenceToFormValue(reference)))),
            Promise.all(input.audioReferences.map((reference) => miniMaxReferenceValue(mediaReferenceToFormValue(reference)))),
        ]);
        images.forEach((url) => content.push({ type: "image_url", image_url: { url }, role: "reference_image" }));
        videos.forEach((url) => content.push({ type: "video_url", video_url: { url }, role: "reference_video" }));
        audios.forEach((url) => content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" }));
    }

    const selectedRatio = normalizeMiniMaxH3Ratio(config.size);
    return {
        model,
        content,
        resolution: normalizeMiniMaxH3Resolution(config.vquality),
        duration: normalizeMiniMaxH3Duration(config.videoSeconds),
        ratio: hasFrames ? "adaptive" : !hasReferences && selectedRatio === "adaptive" ? "16:9" : selectedRatio,
    };
}

async function miniMaxReferenceValue(value: Promise<string | File>) {
    const reference = await value;
    return typeof reference === "string" ? reference : readFileAsDataUrl(reference);
}

async function createCogVideoX3RequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    if (input.videoReferences.length || input.audioReferences.length) throw new VideoRequestError("CogVideoX-3 不支持参考视频或参考音频");
    const frames = [input.firstFrame, input.lastFrame].filter((frame): frame is ReferenceImage => Boolean(frame));
    const references = (frames.length ? frames : input.references).slice(0, 2);
    const imageUrls = await Promise.all(references.map(imageToDataUrl));
    return {
        model,
        prompt,
        quality: normalizeVideoResolution(config.vquality) === "480p" ? "speed" : "quality",
        size: normalizeCogVideoX3Size(config.vquality, config.size),
        duration: Number(normalizeCogVideoX3Duration(config.videoSeconds)),
        with_audio: boolConfig(config.videoGenerateAudio, false),
        ...(imageUrls.length ? { image_url: imageUrls.length === 1 ? imageUrls[0] : imageUrls } : {}),
    };
}

function normalizeCogVideoX3Size(resolutionValue: string, sizeValue: string) {
    const exactSize = normalizeVideoSize(sizeValue);
    if (exactSize && ["1280x720", "720x1280", "1024x1024", "1920x1080", "1080x1920", "2048x1080", "3840x2160"].includes(exactSize)) return exactSize;
    const resolution = normalizeVideoResolution(resolutionValue);
    const ratio = normalizeSeedanceRatio(sizeValue);
    if (ratio === "1:1") return "1024x1024";
    if (ratio === "9:16" || ratio === "3:4") return resolution === "480p" || resolution === "720p" ? "720x1280" : "1080x1920";
    if (resolution === "4k") return "3840x2160";
    if (resolution === "2k") return "2048x1080";
    return resolution === "1080p" ? "1920x1080" : "1280x720";
}

function isAPIMartKlingV26VideoConfig(config: AiConfig, model: string) {
    return isAPIMartKlingVideoConfig(config, model, "kling-v2-6");
}

function isAPIMartKlingV3VideoConfig(config: AiConfig, model: string) {
    return isAPIMartKlingVideoConfig(config, model, "kling-v3");
}

function isAPIMartKlingMotionControlVideoConfig(config: AiConfig, model: string) {
    return isAPIMartKlingVideoConfig(config, model, "kling-v2-6-motion-control") || isAPIMartKlingVideoConfig(config, model, "kling-v3-motion-control");
}

function isKIEKlingMotionControlVideoConfig(config: AiConfig, model: string) {
    return isKIEKlingVideoConfig(config, model, "kling-2-6-motion-control") || isKIEKlingVideoConfig(config, model, "kling-3-0-motion-control");
}

function isAPIMartKlingVideoConfig(config: AiConfig, model: string, key: string) {
    return modelKey(model) === key && videoChannelProtocol(config, model) === "apimart";
}

function isKIEKlingVideoConfig(config: AiConfig, model: string, key: string) {
    return modelKey(model) === key && videoChannelProtocol(config, model) === "kie";
}

function videoChannelProtocol(config: AiConfig, model: string) {
    return channelProtocolForConfig({ ...config, model, videoModel: model });
}

function normalizeCharacterOrientation(value: string | undefined) {
    return value === "image" ? "image" : "video";
}

function normalizeKlingV26Mode(value: string) {
    return value === "pro" ? "pro" : "std";
}

function normalizeAPIMartKlingMotionControlMode(value: string) {
    return normalizeVideoResolution(value) === "1080p" ? "pro" : "std";
}

function normalizeKlingV26Duration(value: string) {
    return String(value).trim() === "10" ? "10" : "5";
}

function normalizeKlingV3Mode(value: string) {
    return value === "4k" ? "4k" : value === "pro" ? "pro" : "std";
}

function normalizeGrokVideoMode(value: string) {
    return value === "fun" || value === "spicy" ? value : "normal";
}

function normalizeKlingV3Duration(value: string) {
    const seconds = Math.floor(Number(value) || 3);
    return String(Math.max(3, Math.min(15, seconds)));
}

function normalizeKlingShotType(value: string) {
    return value === "customize" ? "customize" : "intelligence";
}

function normalizeKlingMultiPrompt(value: AiConfig["videoMultiPrompt"] | undefined) {
    const items = Array.isArray(value) && value.length ? value : [{ prompt: "", duration: "1" }];
    return items.map((item, index) => ({ index: index + 1, prompt: item?.prompt || "", duration: normalizeKlingMultiPromptDuration(item?.duration) }));
}

function normalizeKIEKlingMultiPrompt(value: AiConfig["videoMultiPrompt"] | undefined) {
    const items = Array.isArray(value) && value.length ? value : [{ prompt: "", duration: "1" }];
    return items.map((item) => ({ prompt: item?.prompt || "", duration: normalizeKlingMultiPromptDuration(item?.duration) }));
}

function normalizeKlingMultiPromptDuration(value: string | undefined) {
    const duration = Math.floor(Number(value) || 1);
    return Math.max(1, Math.min(15, duration));
}

async function normalizeKlingElementList(value: AiConfig["videoElementList"] | undefined) {
    const items = Array.isArray(value) ? value.slice(0, 3) : [];
    const result = [];
    for (const item of items) {
        const refs = Array.isArray(item?.references) ? item.references.slice(0, 4) : [];
        if (!refs.length) continue;
        const urls = (await Promise.all(refs.map(elementReferenceToInputUrl))).filter(Boolean).slice(0, 4);
        if (!urls.length) continue;
        result.push({ name: item.name || "", description: item.description || "", element_input_urls: urls });
    }
    return result;
}

async function normalizeKIEKlingElementList(value: AiConfig["videoElementList"] | undefined) {
    const items = Array.isArray(value) ? value.slice(0, 3) : [];
    const result = [];
    for (const item of items) {
        const refs = Array.isArray(item?.references) ? item.references.slice(0, 4) : [];
        if (!refs.length) continue;
        const references = (await Promise.all(refs.map(async (reference) => ({ kind: reference.kind, url: await elementReferenceToInputUrl(reference) })))).filter((reference) => reference.url).slice(0, 4);
        if (!references.length) continue;
        result.push({ name: item.name || "", description: item.description || "", references });
    }
    return result;
}

async function elementReferenceToInputUrl(reference: VideoElementReference) {
    if (reference.kind === "image") {
        const resolvedUrl = await resolveImageUrl(reference.storageKey, "");
        for (const url of [reference.url, resolvedUrl]) {
            const publicUrl = publicHttpUrl(url);
            if (publicUrl) return publicUrl;
        }
        if (reference.dataUrl) return reference.dataUrl;
        return imageToDataUrl({ dataUrl: reference.dataUrl || reference.url || resolvedUrl, storageKey: reference.storageKey });
    }
    const resolvedUrl = await resolveMediaUrl(reference.storageKey, reference.url || "");
    return publicHttpUrl(resolvedUrl) || publicHttpUrl(reference.url) || resolvedUrl || reference.url || "";
}

function normalizeKlingV26AspectRatio(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["9:16", "720x1280", "1080x1920"].includes(normalized)) return "9:16";
    if (["1:1", "1024x1024", "1080x1080"].includes(normalized)) return "1:1";
    return "16:9";
}

function normalizeVideoReferenceInput(input: ReferenceImage[] | VideoReferenceInput): Required<VideoReferenceInput> {
    if (Array.isArray(input)) return { references: input, videoReferences: [], audioReferences: [], firstFrame: null, lastFrame: null };
    return { references: input.references || [], videoReferences: input.videoReferences || [], audioReferences: input.audioReferences || [], firstFrame: input.firstFrame || null, lastFrame: input.lastFrame || null };
}

async function imageReferenceToFile(image: ReferenceImage) {
    return dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) });
}

async function imageReferenceToFormValue(image: ReferenceImage) {
    const resolvedUrl = await resolveImageUrl(image.storageKey, "");
    for (const url of [image.url, resolvedUrl, image.dataUrl]) {
        const publicUrl = publicHttpUrl(url);
        if (publicUrl) return publicUrl;
    }
    return imageReferenceToFile(image);
}

async function mediaReferenceToFile(media: ReferenceVideo | ReferenceAudio) {
    const url = await resolveMediaUrl(media.storageKey, media.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`参考素材读取失败：${response.status}`);
    const blob = await response.blob();
    return new File([blob], media.name || "reference", { type: media.type || blob.type || "application/octet-stream" });
}

async function mediaReferenceToFormValue(media: ReferenceVideo | ReferenceAudio) {
    const resolvedUrl = await resolveMediaUrl(media.storageKey, media.url);
    const publicUrl = publicHttpUrl(resolvedUrl) || publicHttpUrl(media.url);
    if (publicUrl) return publicUrl;
    return mediaReferenceToFile(media);
}

async function imageToAgnesReference(image: ReferenceImage) {
    const resolvedUrl = await resolveImageUrl(image.storageKey, "");
    for (const url of [image.dataUrl, image.url, resolvedUrl]) {
        const publicUrl = publicHttpUrl(url);
        if (publicUrl) return publicUrl;
    }
    return imageToDataUrl(image);
}

async function agnesVideoV25ReferenceUrl(reference: ReferenceImage | ReferenceVideo | ReferenceAudio) {
    const resolvedUrl = "dataUrl" in reference
        ? await resolveImageUrl(reference.storageKey, reference.url || "")
        : await resolveMediaUrl(reference.storageKey, reference.url);
    const url = publicHttpUrl(reference.url) || ("dataUrl" in reference ? publicHttpUrl(reference.dataUrl) : "") || publicHttpUrl(resolvedUrl);
    if (!url) throw new VideoRequestError("Agnes Video 2.5 的参考素材必须具有公网访问地址");
    return url;
}

function publicHttpUrl(value?: string) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return "";
    try {
        const url = new URL(value, typeof window === "undefined" ? undefined : window.location.origin);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "";
        return url.href;
    } catch {
        return "";
    }
}

function agnesFrameRate(secondsValue: string) {
    const seconds = Number(normalizeVideoSeconds(secondsValue));
    return seconds > 18 ? Math.max(1, Math.floor(440 / seconds)) : 24;
}

function agnesNumFrames(secondsValue: string, frameRate: number) {
    const target = Math.round(Number(normalizeVideoSeconds(secondsValue)) * frameRate) + 1;
    const capped = Math.min(441, Math.max(9, target));
    return capped - ((capped - 1) % 8);
}

function isAgnesVideoModel(model: string) {
    return model.toLowerCase().includes("agnes-video");
}

function videoPollId(model: string, task: VideoResponse) {
    return isAgnesVideoModel(model) ? task.video_id || task.id : task.id || task.task_id || task.video_id || "";
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(30, seconds)));
}

function isGeminiOmniFlashVideoModel(model: string) {
    return modelKey(model) === "gemini-omni-flash-preview";
}

function normalizeVideoSecondsForModel(model: string, value: string) {
    const seconds = Number(normalizeVideoSeconds(value));
    const key = modelKey(model);
    if (key.includes("sora-2")) return closestAllowedSeconds(seconds, [4, 8, 12, 16, 20]);
    if (key.includes("veo3-1") || key.includes("veo-3-1")) return "8";
    if (key.includes("minimax-hailuo-02")) return closestAllowedSeconds(seconds, [5, 10]);
    if (key.includes("minimax-hailuo-2-3")) return closestAllowedSeconds(seconds, [6, 10]);
    if (key.includes("omni-flash-ext")) return closestAllowedSeconds(seconds, [4, 6, 8, 10]);
    if (key.includes("wan2-5") || key.includes("wan2.5")) return closestAllowedSeconds(seconds, [5, 10]);
    if (key === "wan2-6") return closestAllowedSeconds(seconds, [5, 10, 15]);
    return String(seconds);
}

function closestAllowedSeconds(seconds: number, allowed: number[]) {
    return String(allowed.reduce((best, item) => Math.abs(item - seconds) < Math.abs(best - seconds) ? item : best, allowed[0]));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function parseVideoDimensions(size: string) {
    const match = size.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.trim().replace(/p$/i, "") || "720";
    return /k$/i.test(resolution) ? resolution.toLowerCase() : `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    if (!payload) throw new Error("接口没有返回视频任务");
    if (isVideoEnvelope(payload)) {
        if (payload.code !== 0) throw new VideoRequestError(payload.msg || payload.message || "请求失败", payload);
        if (!payload.data || Array.isArray(payload.data)) throw new Error("接口没有返回视频任务");
        return normalizeVideoResponse(payload.data);
    }
    const error = videoPayloadErrorMessage(payload);
    if (error) throw new VideoRequestError(error, payload);
    if (payload.error?.message) throw new VideoRequestError(payload.error.message, payload);
    return normalizeVideoResponse(payload);
}

function unwrapVideoResponseForConfig(config: AiConfig, model: string, payload: ApiVideoResponse) {
    if (isGeminiVideoModel(model) && isGeminiConfig(config, model)) return normalizeGeminiVideoResponse(payload);
    if (isMiniMaxH3Config(config, model)) {
        const root = payload as unknown as Record<string, unknown>;
        const task = root.task && typeof root.task === "object" ? root.task as Record<string, unknown> : null;
        if (task) {
            const content = task.content && typeof task.content === "object" ? task.content as Record<string, unknown> : {};
            return normalizeVideoResponse({
                ...task,
                task_id: firstString(task.id),
                video_url: firstString(content.url, task.video_url),
                seconds: task.duration == null ? undefined : String(task.duration),
                size: firstString(task.resolution, task.size),
            });
        }
    }
    return unwrapVideoResponse(payload);
}

async function createGeminiVeoRequestBody(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    if (input.videoReferences.length) throw new VideoRequestError("Gemini Veo 不支持普通参考视频，请移除后重试");
    if (input.audioReferences.length) throw new VideoRequestError("Gemini Veo 不支持参考音频，请移除后重试");
    if (input.lastFrame && !input.firstFrame) throw new VideoRequestError("请先添加首帧图片");
    const hasFrames = Boolean(input.firstFrame || input.lastFrame);
    if (hasFrames && input.references.length) throw new VideoRequestError("首尾帧模式不能与普通参考图同时使用");
    if ((input.lastFrame || input.references.length) && !isGeminiVeo31Model(model)) throw new VideoRequestError("当前 Veo 模型不支持尾帧或普通参考图");
    if (input.references.length > 3) throw new VideoRequestError("Veo 3.1 参考图最多 3 张");

    const instance: Record<string, unknown> = { prompt };
    if (input.firstFrame) instance.image = dataUrlToGeminiInlineData(await imageToDataUrl(input.firstFrame));
    if (input.lastFrame) instance.lastFrame = dataUrlToGeminiInlineData(await imageToDataUrl(input.lastFrame));
    if (input.references.length) {
        const images = await Promise.all(input.references.map(imageToDataUrl));
        instance.referenceImages = images.map((image) => ({ image: dataUrlToGeminiInlineData(image), referenceType: "asset" }));
    }
    const resolution = normalizeGeminiVideoResolution(config.vquality);
    const forceEightSeconds = resolution !== "720p" || hasFrames || input.references.length > 0;
    const aspectRatio = normalizeGeminiVideoRatio(config.size);
    return {
        model,
        instances: [instance],
        parameters: {
            ...(aspectRatio ? { aspectRatio } : {}),
            durationSeconds: normalizeGeminiVideoDuration(config.videoSeconds, forceEightSeconds),
            resolution,
        },
    };
}

function normalizeGeminiVideoResponse(payload: ApiVideoResponse): VideoResponse {
    const root = payload as unknown as Record<string, unknown>;
    if (typeof root.code === "number") return unwrapVideoResponse(payload);
    const name = firstString(root.name);
    const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : {};
    const videoUrl = geminiVideoUri(root);
    const done = root.done === true;
    return normalizeVideoResponse({
        ...root,
        id: name,
        task_id: name,
        status: Object.keys(error).length ? "failed" : done && videoUrl ? "completed" : done ? "failed" : "processing",
        progress: done ? 100 : 0,
        video_url: videoUrl,
        error: Object.keys(error).length ? { message: geminiErrorMessage(root, "视频生成失败") } : done && !videoUrl ? { message: "Gemini Veo 任务完成但没有返回视频地址" } : undefined,
    });
}

function geminiVideoUri(value: unknown, depth = 0): string {
    if (depth > 8 || value == null) return "";
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : "";
    if (Array.isArray(value)) return value.map((item) => geminiVideoUri(item, depth + 1)).find(Boolean) || "";
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.uri, record.videoUri, record.video_url, record.url);
    if (/^https?:\/\//.test(direct)) return direct;
    for (const item of Object.values(record)) {
        const found = geminiVideoUri(item, depth + 1);
        if (found) return found;
    }
    return "";
}

async function cacheProtectedGeminiVideo(config: AiConfig, model: string, task: VideoResponse) {
    const url = task.video_url || task.url || "";
    if (!isGeminiConfig(config, model) || !isCompletedVideoStatus(task.status) || task.storageKey || !url) return task;
    const localTaskId = task.id || task.task_id || "";
    const response = await fetch(
        usesAccountProxy(config) ? `${aiApiUrl(config, `/videos/${encodeURIComponent(localTaskId)}/content`)}?model=${encodeURIComponent(model)}` : url,
        { headers: usesAccountProxy(config) ? aiHeaders(config) : geminiDirectHeaders(config) },
    );
    if (!response.ok) throw new VideoRequestError(`视频内容下载失败：${response.status}`, task);
    const media = await uploadMediaFile(await response.blob(), "generated-video");
    return { ...task, url: media.url, video_url: media.url, storageKey: media.storageKey };
}

function withoutVideoModel(body: FormData | Record<string, unknown>) {
    if (body instanceof FormData) return body;
    const { model: _model, ...nativeBody } = body;
    return nativeBody;
}

function isVideoEnvelope(payload: ApiVideoResponse): payload is ApiVideoEnvelope {
    return "code" in payload && typeof payload.code === "number";
}

function readAxiosError(error: unknown, fallback: string) {
    if (error instanceof VideoRequestError) return { message: error.message, detail: error.detail || error.stack || error.message };
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return { message: responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback), detail: responseData || error.message };
    }
    return { message: error instanceof Error ? error.message : fallback, detail: error instanceof Error ? error.stack || error.message : error };
}

async function writeVideoAICallLog(config: AiConfig, model: string, endpoint: string, method: "GET" | "POST", startedAt: number, status: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local" || usesAccountProxy(config)) return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method,
            model,
            channelId: channel?.id || config.activeChannelId || "",
            channelName: channel?.name || "本地直连",
            status,
            durationMs: Date.now() - startedAt,
            credits: 0,
            requestBody,
            responseBody,
            error,
        }),
    }).catch(() => { });
}

function summarizeVideoRequestBody(value: unknown) {
    if (value instanceof FormData) {
        const fields: Record<string, string[]> = {};
        const files: Array<{ field: string; name: string; size: number; type: string }> = [];
        value.forEach((item, key) => {
            if (item instanceof File) {
                files.push({ field: key, name: item.name, size: item.size, type: item.type });
                return;
            }
            fields[key] = [...(fields[key] || []), String(item)];
        });
        return { fields, files };
    }
    return value;
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogMedia(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogMedia(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogMedia);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || item.startsWith("data:video/") || item.startsWith("data:audio/") || item.includes("data:image/") || item.includes("data:video/") || item.includes("data:audio/") || item.length > 2048 && looksLikeBase64(item))) {
            record[key] = `[redacted media/string len=${item.length}]`;
            continue;
        }
        redactLogMedia(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function normalizeVideoResponse(value: unknown): VideoResponse {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const id = firstString(record.id, record.request_id, record.task_id, record.video_id, firstTaskId(record));
    return {
        ...(record as VideoResponse),
        id,
        task_id: firstString(record.task_id, record.id),
        video_id: firstString(record.video_id),
        source_id: firstString(record.source_id, record.sourceId),
        sourceId: firstString(record.sourceId, record.source_id),
        channelId: firstString(record.channelId, record.channel_id),
        userChannelId: firstString(record.userChannelId, record.user_channel_id),
        channelName: firstString(record.channelName, record.channel_name),
        status: firstString(record.status, record.state, record.task_status),
        video_url: firstString(record.video_url, record.videoUrl, record.remixed_from_video_id, record.output_url, record.download_url, firstVideoUrl(record)),
        progress: typeof record.progress === "number" ? record.progress : (typeof record.progress === "string" ? parseFloat(record.progress) : undefined),
    };
}

function buildVideoGenerationResult(task: VideoResponse, url: string, durationMs: number): VideoGenerationResult {
    const size = parseVideoSize((task as Record<string, unknown>).size);
    return { id: task.id, url, durationMs, width: size.width, height: size.height, bytes: 0, mimeType: "video/mp4", task };
}

function parseVideoSize(value: unknown) {
    const match = typeof value === "string" ? value.match(/^(\d+)x(\d+)$/) : null;
    return { width: match ? Number(match[1]) : 1280, height: match ? Number(match[2]) : 720 };
}

function firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && !!value.trim())?.trim() || "";
}

function isCompletedVideoStatus(status?: string) {
    return ["completed", "complete", "done", "succeeded", "success"].includes((status || "").toLowerCase());
}

function isFailedVideoStatus(status?: string) {
    return ["failed", "fail", "error", "cancelled", "canceled", "timed_out"].includes((status || "").toLowerCase());
}

function videoPayloadErrorMessage(value: unknown): string {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof record.code === "number" && record.code !== 0) return firstString(record.msg, record.message, nestedMessage(record.error)) || "视频下载失败";
    if (typeof record.code === "string" && /fail|error/i.test(record.code)) return firstString(nestedMessage(record.error), record.msg, record.message, record.code);
    return firstString(nestedMessage(record.error));
}

function nestedMessage(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return firstString((value as Record<string, unknown>).message);
}

function firstVideoUrl(value: unknown, depth = 0): string {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstVideoUrl(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.video_url, record.videoUrl, record.url, record.remixed_from_video_id, record.output_url, record.download_url, record.file_url);
    if (/^https?:\/\//.test(direct)) return direct;
    for (const key of ["video_result", "video", "data", "output", "result", "content", "metadata"]) {
        const found = firstVideoUrl(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}

function firstTaskId(value: unknown, depth = 0): string {
    if (depth > 4 || value == null) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstTaskId(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.id, record.request_id, record.task_id, record.video_id);
    if (direct) return direct;
    for (const key of ["data", "result", "output", "video"]) {
        const found = firstTaskId(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}

// 兼容旧版 video/page.tsx 的导出名
export type { VideoGenerationResult as VideoGenerationTask };

export async function pollVideoGenerationTask(taskId: string): Promise<VideoResponse> {
    const config = { channelMode: "remote" as const, model: "", videoModel: "" } as AiConfig;
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    const response = await axios.get<ApiVideoEnvelope>(aiApiUrl(config, `/videos/${encodeURIComponent(taskId)}?model=`), { headers: { Authorization: `Bearer ${token}` } });
    return unwrapVideoResponse(response.data);
}

export function storeGeneratedVideo(result: VideoGenerationResult) {
    return result;
}
