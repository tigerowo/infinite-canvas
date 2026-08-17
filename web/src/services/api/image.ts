import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { isKIESeedreamLayerDecompositionModel } from "@/lib/kie-models";
import { isMimoChannel, mimoModels } from "@/lib/mimo-tts";
import { imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, directAIProviderForConfig, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { nanoid } from "nanoid";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ResponsesApiResponse = {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type GeneratedImage = { id: string; dataUrl: string; seed?: number };
export type CanvasImageTask = {
    id: string;
    parent_task_id?: string;
    object?: string;
    source?: string;
    source_id?: string;
    node_id?: string;
    channelId?: string;
    userChannelId?: string;
    channelName?: string;
    model?: string;
    prompt?: string;
    status: "queued" | "processing" | "completed" | "failed" | string;
    progress?: number;
    url?: string;
    image_url?: string;
    image_urls?: string[];
    storageKey?: string;
    width?: number;
    height?: number;
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
export type CanvasImageTaskOptions = { nodeId?: string; source?: "canvas" | "image-workbench" | "workflow"; sourceId?: string; clientTaskId?: string };

type ParsedImageResponse = {
    images: GeneratedImage[];
    responseBody: string;
};

export class ImageRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "ImageRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

type ImageRequestParams = {
    n: number;
    quality: string;
    size?: string;
    timeoutSeconds: number;
    streamPartialImages: number;
};

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const IMAGE_MIME = "image/png";
const IMAGE_REQUEST_TIMEOUT_SECONDS = 600;
const PROMPT_REWRITE_GUARD_PREFIX = "Use the following text as the complete prompt. Do not rewrite it:";

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    if (!value || value === "auto") return "auto";
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : "auto";
}

function normalizeBoundedInteger(value: string | number, fallback: number, min: number, max: number) {
    const number = Math.floor(Math.abs(Number(value)));
    if (!Number.isFinite(number) || number < min) return fallback;
    return Math.max(min, Math.min(max, number));
}

function greatestCommonDivisor(a: number, b: number) {
    a = Math.round(a);
    b = Math.round(b);
    while (b) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return a;
}

function resolveSize(quality: string, ratio: string): string | undefined {
    const basePixels = QUALITY_BASE[quality];
    if (!basePixels || ratio === "auto" || !ratio) return undefined;

    const parts = ratio.split(":");
    if (parts.length !== 2) return undefined;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) return undefined;

    const a = greatestCommonDivisor(w, h);

    const unit = Math.round(Math.sqrt((basePixels * basePixels) / ((w / a) * (h / a))) / 16) * 16;
    return `${(w / a) * unit}x${(h / a) * unit}`;
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value === "auto") return undefined;
    if (/^\d+x\d+$/.test(value)) return value;
    // 用户只选了宽高比时,即使 quality=auto 也要折算成具体像素尺寸,避免 "1:1" 这种非法值发到 API。
    return resolveSize(quality && QUALITY_BASE[quality] ? quality : "low", value);
}

function createImageRequestParams(config: AiConfig): ImageRequestParams {
    const normalizedQuality = normalizeQuality(config.quality);
    const zhipu = isZhipuImageModel(config.model);
    const quality = zhipu ? normalizeZhipuImageQuality(config.model, normalizedQuality) : normalizedQuality;
    return {
        n: normalizeBoundedInteger(config.count, 1, 1, 15),
        quality,
        size: resolveRequestSize(quality, config.size),
        timeoutSeconds: IMAGE_REQUEST_TIMEOUT_SECONDS,
        streamPartialImages: normalizeBoundedInteger(config.streamPartialImages, 1, 0, 3),
    };
}

function isGrokImageModel(model: string) {
    return model.trim().toLowerCase().startsWith("grok-imagine-image");
}

function isZhipuImageModel(model: string) {
    const value = model.trim().toLowerCase();
    return value === "glm-image" || value.startsWith("cogview-");
}

function normalizeZhipuImageQuality(model: string, quality: string) {
    if (model.trim().toLowerCase() === "glm-image") return "hd";
    if (quality === "auto") return quality;
    return quality === "high" || quality === "hd" ? "hd" : "standard";
}

function applyImageGenerationParams(body: Record<string, unknown>, config: AiConfig, params: ImageRequestParams, operation: "generation" | "edit" = "generation") {
    const model = config.model.trim().toLowerCase();
    const zhipu = isZhipuImageModel(model);
    if (zhipu) {
        if (params.size) body.size = params.size;
        if (params.quality !== "auto") body.quality = params.quality;
        return;
    }

    const grok = isGrokImageModel(model) && (operation === "edit" || !model.includes("edit"));
    if (grok) {
        const size = config.size.trim().toLowerCase();
        if (size && size !== "auto") {
            const match = size.match(/^(\d+)x(\d+)$/);
            if (match) {
                const width = Number(match[1]);
                const height = Number(match[2]);
                const divisor = greatestCommonDivisor(width, height);
                body.aspect_ratio = `${width / divisor}:${height / divisor}`;
            } else {
                body.aspect_ratio = size;
            }
        }
        if (params.quality !== "auto") {
            body.resolution = operation === "edit" && model.includes("edit") ? "1k" : QUALITY_BASE[params.quality] > 1024 ? "2k" : "1k";
        }
        return;
    }

    if (params.size) body.size = params.size;
    if (params.quality && !config.codexCli) body.quality = params.quality;
}

function applyImageGenerationOptions(body: Record<string, unknown>, config: AiConfig, params: ImageRequestParams) {
    if (isZhipuImageModel(config.model)) return;
    if (params.n > 1) body.n = params.n;
    if (config.responseFormatB64Json) body.response_format = "b64_json";
    if (config.streamImages) {
        body.stream = true;
        body.partial_images = params.streamPartialImages;
    }
}

function assertImageReferencesSupported(model: string, references: ReferenceImage[]) {
    if (references.length && isZhipuImageModel(model)) throw new ImageRequestError("智谱 GLM-Image 和 CogView 仅支持文生图");
}

function normalizeBase64Image(value: string, fallbackMime: string) {
    return value.startsWith("data:") ? value : `data:${fallbackMime};base64,${value}`;
}

function resolveImageDataUrl(item: Record<string, unknown>, mime: string) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return normalizeBase64Image(item.b64_json, mime);
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.data
            ?.map((item) => resolveImageDataUrl(item, mime))
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("接口没有返回图片", payload);
    }

    return images;
}

function getStringRecordValue(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function collectResponsesImageStrings(value: unknown, depth = 0): string[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.flatMap((item) => collectResponsesImageStrings(item, depth + 1));
    if (typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ["result", "b64_json", "base64", "image", "image_data", "data"].flatMap((key) => collectResponsesImageStrings(record[key], depth + 1));
}

function getResponsesImageResultBase64(result: unknown) {
    return collectResponsesImageStrings(result)[0] || "";
}

function collectResponsesImageBase64(item: Record<string, unknown>) {
    const values: string[] = [];
    const result = getResponsesImageResultBase64(item.result);
    if (result) values.push(result);
    values.push(...collectResponsesImageStrings(item));
    return Array.from(new Set(values));
}

function parseResponsesPayload(payload: ResponsesApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.output
            ?.filter((item) => item.type === "image_generation_call")
            .flatMap((item) => collectResponsesImageBase64(item))
            .filter(Boolean)
            .map((b64) => ({ id: nanoid(), dataUrl: normalizeBase64Image(b64, mime) })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("Responses API 没有返回图片", payload);
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

async function fetchErrorDetail(response: Response, fallback: string) {
    try {
        const text = await response.text();
        if (!text.trim()) return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
        try {
            const payload = JSON.parse(text) as { error?: { message?: string }; msg?: string; message?: string };
            return { message: payload.msg || payload.error?.message || payload.message || `${fallback}：${response.status}`, detail: payload };
        } catch {
            return { message: text.trim() || `${fallback}：${response.status}`, detail: text };
        }
    } catch {
        return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
    }
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

function timeoutError(timeoutSeconds: number) {
    return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试。`;
}

async function withTimeout<T>(timeoutSeconds: number, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await run(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new Error(timeoutError(timeoutSeconds));
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function isTransientStatus(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number) {
    return 700 * attempt;
}

async function requestWithTransientRetry(run: () => Promise<Response>, retries = 2) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await run();
            if (!isTransientStatus(response.status) || attempt === retries) return response;
            lastError = new Error(`上游接口临时不可用：${response.status}`);
        } catch (error) {
            lastError = error;
            if (attempt === retries) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function parseServerSentEventBlock(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return null;
    return JSON.parse(data) as Record<string, unknown>;
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) throw new ImageRequestError("接口未返回可读取的流式响应", `${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];

    const processBlock = (block: string) => {
        let event: Record<string, unknown> | null = null;
        try {
            event = parseServerSentEventBlock(block);
        } catch (error) {
            throw new ImageRequestError(error instanceof Error ? error.message : "流式响应解析失败", block);
        }
        if (!event) return;
        events.push(event);
        const error = event.error;
        if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { message?: unknown }).message === "string") {
            throw new ImageRequestError((error as { message: string }).message, event);
        }
        onEvent(event);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.search(/\r?\n\r?\n/);
        while (separatorIndex >= 0) {
            const separator = buffer.match(/\r?\n\r?\n/)?.[0] || "\n\n";
            processBlock(buffer.slice(0, separatorIndex));
            buffer = buffer.slice(separatorIndex + separator.length);
            separatorIndex = buffer.search(/\r?\n\r?\n/);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return events;
}

function isEventStreamResponse(response: Response) {
    return response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream") ?? false;
}

async function parseImagesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    const imageItems = new Map<string, Record<string, unknown>>();
    let resultPayload: ImageApiResponse | null = null;
    const events = await readJsonServerSentEvents(response, (event) => {
        const object = typeof event.object === "string" ? event.object : "";
        if (object === "image.generation.result" || object === "image.edit.result") {
            resultPayload = event as ImageApiResponse;
        }
        if (resolveImageDataUrl(event, mime)) {
            const imageIndex =
                typeof event.image_index === "number" || typeof event.image_index === "string" ? String(event.image_index) : `event-${imageItems.size}`;
            imageItems.set(imageIndex, event);
        }
    });
    if (resultPayload) return parseImagePayload(resultPayload, mime);
    if (imageItems.size) return parseImagePayload({ data: Array.from(imageItems.values()) }, mime);
    throw new ImageRequestError("流式接口未返回最终图片数据", events);
}

async function parseResponsesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    let completedPayload: ResponsesApiResponse | null = null;
    const output: Record<string, unknown>[] = [];
    const partialImages: string[] = [];
    const events = await readJsonServerSentEvents(response, (event) => {
        if (event.type === "response.image_generation_call.partial_image") {
            const b64 = getStringRecordValue(event, "partial_image_b64");
            if (b64) partialImages.push(b64);
            return;
        }
        const responsePayload = event.response;
        if (responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)) {
            completedPayload = responsePayload as ResponsesApiResponse;
        }
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "image_generation_call") {
            output.push(item as Record<string, unknown>);
        }
    });
    try {
        return parseResponsesPayload(completedPayload || { output }, mime);
    } catch (error) {
        if (!partialImages.length) {
            throw new ImageRequestError(error instanceof Error ? error.message : "Responses API 没有返回图片", {
                completedPayload,
                output,
                events,
            });
        }
        const lastPartialImage = partialImages[partialImages.length - 1];
        return [{ id: nanoid(), dataUrl: normalizeBase64Image(lastPartialImage, mime) }];
    }
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = (config.systemPrompts.image || config.systemPrompt).trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withPromptGuard(config: AiConfig, prompt: string) {
    return config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
}

function usesAccountProxy(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote" || (config.channelMode === "local" && Boolean(token));
}

export function aiApiUrl(config: AiConfig, path: string) {
    if (usesAccountProxy(config)) return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

export function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    if (config.channelMode === "remote") {
        return {
            Authorization: `Bearer ${token}`,
            ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
            ...(contentType ? { "Content-Type": contentType } : {}),
        };
    }
    if (token) {
        const userChannelId = channelIdForActiveModel(config);
        return {
            Authorization: `Bearer ${token}`,
            ...(userChannelId ? { "X-User-Model-Channel-ID": userChannelId } : {}),
            ...(contentType ? { "Content-Type": contentType } : {}),
        };
    }
    return {
        Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export function refreshRemoteUser(config: AiConfig) {
    if (usesAccountProxy(config)) void useUserStore.getState().hydrateUser();
}

async function writeLocalAICallLog(config: AiConfig, endpoint: string, startedAt: number, status: number, timeoutSeconds: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local" || usesAccountProxy(config)) return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method: "POST",
            model: config.model,
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

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogImages(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogImages(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogImages);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || item.length > 2048 && looksLikeBase64(item))) {
            record[key] = `[redacted image/string len=${item.length}]`;
            continue;
        }
        redactLogImages(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function summarizeFormData(formData: FormData) {
    const fields: Record<string, string[]> = {};
    const files: Array<{ field: string; name: string; size: number; type: string }> = [];
    formData.forEach((value, key) => {
        if (value instanceof File) {
            files.push({ field: key, name: value.name, size: value.size, type: value.type });
            return;
        }
        fields[key] = [...(fields[key] || []), String(value)];
    });
    return { fields, files };
}

function summarizeGeneratedImages(images: GeneratedImage[], source: string) {
    return stringifyLogPayload({
        source,
        imageCount: images.length,
        images: images.map((image) => ({ id: image.id, dataUrl: image.dataUrl.startsWith("data:image/") ? `[redacted image len=${image.dataUrl.length}]` : image.dataUrl })),
    });
}

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = (config.systemPrompts.text || config.systemPrompt).trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

async function requestImageGenerationSingle(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = IMAGE_MIME;

    // 针对 Agnes 渠道文生图模型定制精简 Payload，避免传入官方文档未声明的 seed 参数。
    if (isAgnesImageModel(config.model)) {
        const body: Record<string, unknown> = {
            model: config.model,
            prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        };
        applyAgnesImageSize(body, config, params);

        return requestAndParseImages(
            config,
            "/images/generations",
            body,
            params.timeoutSeconds,
            () =>
                requestWithTransientRetry(() =>
                    withTimeout(params.timeoutSeconds, (signal) =>
                        fetch(aiApiUrl(config, "/images/generations"), {
                            method: "POST",
                            headers: aiHeaders(config, "application/json"),
                            body: JSON.stringify(body),
                            signal,
                        }),
                    ),
                ),
            async (response) => {
                if (config.streamImages && isEventStreamResponse(response)) {
                    const images = await parseImagesStreamResponse(response, mime);
                    return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
                }
                const payload = (await response.json()) as ImageApiResponse;
                const images = parseImagePayload(payload, mime);
                return { images, responseBody: stringifyLogPayload(payload) };
            },
        );
    }

    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
    };
    applyImageGenerationParams(body, config, params);
    applyImageGenerationOptions(body, config, params);

    const directProvider = !usesAccountProxy(config) ? directAIProviderForConfig(config) : null;
    if (directProvider) {
        const { requestDirectImages } = await import("@/services/api/direct-ai");
        return parseImagePayload(await requestDirectImages(config, directProvider, "/images/generations", body, params.timeoutSeconds), mime);
    }

    return requestAndParseImages(
        config,
        "/images/generations",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function createGrokImageEditBody(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams) {
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        images: await Promise.all(references.map(async (image) => ({ url: await imageToDataUrl(image) }))),
    };
    if (params.n > 1) body.n = params.n;
    applyImageGenerationParams(body, config, params, "edit");
    if (config.responseFormatB64Json) body.response_format = "b64_json";
    if (config.streamImages) {
        body.stream = true;
        body.partial_images = params.streamPartialImages;
    }
    return body;
}

async function requestGrokImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = IMAGE_MIME;
    const body = await createGrokImageEditBody(config, prompt, references, params);
    return requestAndParseImages(
        config,
        "/images/edits",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/edits"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    if (isGrokImageModel(config.model)) return requestGrokImageEditSingle(config, prompt, references, params);

    const mime = IMAGE_MIME;
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withPromptGuard(config, withSystemPrompt(config, prompt)));
    if (params.n > 1) formData.set("n", String(params.n));
    if (params.size) formData.set("size", params.size);
    if (params.quality && !config.codexCli) formData.set("quality", params.quality);
    if (config.responseFormatB64Json) formData.set("response_format", "b64_json");
    if (config.streamImages) {
        formData.set("stream", "true");
        formData.set("partial_images", String(params.streamPartialImages));
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));

    const directProvider = !usesAccountProxy(config) ? directAIProviderForConfig(config) : null;
    if (directProvider) {
        const { requestDirectImages } = await import("@/services/api/direct-ai");
        return parseImagePayload(await requestDirectImages(config, directProvider, "/images/edits", formData, params.timeoutSeconds), mime);
    }

    return requestAndParseImages(
        config,
        "/images/edits",
        summarizeFormData(formData),
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/edits"), {
                        method: "POST",
                        headers: aiHeaders(config),
                        body: formData,
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

function createResponsesImageTool(config: AiConfig, params: ImageRequestParams, isEdit: boolean) {
    const tool: Record<string, unknown> = {
        type: "image_generation",
        action: isEdit ? "edit" : "generate",
        size: params.size || "auto",
    };
    if (params.quality && !config.codexCli) tool.quality = params.quality;
    if (config.streamImages) tool.partial_images = params.streamPartialImages;
    return tool;
}

function createResponsesInput(config: AiConfig, prompt: string, inputImageDataUrls: string[]) {
    const text = config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
    if (!inputImageDataUrls.length) return text;
    return [
        {
            role: "user",
            content: [
                { type: "input_text", text },
                ...inputImageDataUrls.map((dataUrl) => ({
                    type: "input_image",
                    image_url: dataUrl,
                })),
            ],
        },
    ];
}

async function requestResponsesSingle(config: AiConfig, prompt: string, inputImageDataUrls: string[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = IMAGE_MIME;
    const body: Record<string, unknown> = {
        model: config.model,
        input: createResponsesInput(config, withSystemPrompt(config, prompt), inputImageDataUrls),
        tools: [createResponsesImageTool(config, params, inputImageDataUrls.length > 0)],
        tool_choice: "required",
    };
    if (config.streamImages) body.stream = true;

    return requestAndParseImages(
        config,
        "/responses",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/responses"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseResponsesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ResponsesApiResponse;
            return { images: parseResponsesPayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestAndParseImages(config: AiConfig, endpoint: string, requestBody: unknown, timeoutSeconds: number, fetchResponse: () => Promise<Response>, parseResponse: (response: Response) => Promise<ParsedImageResponse>) {
    const startedAt = Date.now();
    let logged = false;
    try {
        const response = await fetchResponse();
        if (!response.ok) {
            const error = await fetchErrorDetail(response, "请求失败");
            logged = true;
            void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), stringifyLogPayload(error.detail || error.message), error.message);
            throw new ImageRequestError(error.message, error.detail);
        }
        const parsed = await parseResponse(response);
        logged = true;
        void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), parsed.responseBody, "");
        return parsed.images;
    } catch (error) {
        if (!logged) {
            void writeLocalAICallLog(config, endpoint, startedAt, 0, timeoutSeconds, stringifyLogPayload(requestBody), "", error instanceof ImageRequestError ? error.detail || error.message : error instanceof Error ? error.message : "请求失败");
        }
        throw error;
    }
}

async function requestImages(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[]): Promise<GeneratedImage[]> {
    assertImageReferencesSupported(config.model, references);
    const params = createImageRequestParams(config);
    const inputImageDataUrls = references.length ? await Promise.all(references.map((image) => imageToDataUrl(image))) : [];
    const useConcurrentSingleRequests = config.apiMode === "responses" || config.codexCli || config.streamImages || isZhipuImageModel(config.model);
    if (params.n > 1 && useConcurrentSingleRequests) {
        const results = await Promise.allSettled(Array.from({ length: params.n }, () => requestImages({ ...config, count: "1" }, prompt, references)));
        const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (images.length) return images;
        const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstError?.reason || new Error("所有并发请求均失败");
    }
    if (references.length && isAgnesImageModel(config.model)) {
        return requestAgnesImageEdit(config, prompt, references, params);
    }
    if (config.apiMode === "responses" && !isZhipuImageModel(config.model)) return requestResponsesSingle(config, prompt, inputImageDataUrls, params);
    return references.length ? requestImageEditSingle(config, prompt, references, params) : requestImageGenerationSingle(config, prompt, params);
}

export async function requestGeneration(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string) {
    try {
        const images = await requestImages(config, prompt, []);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[]) {
    try {
        const images = await requestImages(config, prompt, references);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function createCanvasImageTask(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], options: CanvasImageTaskOptions = {}): Promise<CanvasImageTask> {
    if (!usesAccountProxy(config)) {
        const images = await requestImages({ ...config, count: "1" }, prompt, references);
        const [image] = images;
        if (!image) throw new Error("接口没有返回图片");
        return {
            id: options.clientTaskId || nanoid(),
            source: options.source || "canvas",
            source_id: options.sourceId || "",
            node_id: options.nodeId || "",
            model: config.model,
            prompt,
            status: "completed",
            progress: 100,
            image_url: image.dataUrl,
            ...(isKIESeedreamLayerDecompositionModel(config.model) ? { image_urls: images.map((item) => item.dataUrl) } : {}),
        };
    }
    const params = createImageRequestParams({ ...config, count: "1" });
    const request = await createCanvasImageTaskRequest({ ...config, count: "1" }, prompt, references, params, options);
    const response = await fetch("/api/v1/canvas/image-tasks", request);
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "图片任务创建失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasImageTask };
    if (payload.code !== 0 || !payload.data) throw new ImageRequestError(payload.msg || "图片任务创建失败", payload);
    refreshRemoteUser(config);
    return payload.data;
}

export async function pollCanvasImageTaskStatus(taskId: string): Promise<CanvasImageTask> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用云端渠道");
    const response = await fetch(`/api/v1/canvas/image-tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "读取图片任务失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasImageTask };
    if (payload.code !== 0 || !payload.data) throw new ImageRequestError(payload.msg || "读取图片任务失败", payload);
    return payload.data;
}

async function createCanvasImageTaskRequest(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], params: ImageRequestParams, options: CanvasImageTaskOptions): Promise<RequestInit> {
    assertImageReferencesSupported(config.model, references);
    const taskChannelId = channelIdForActiveModel(config);
    const taskChannelHeader: Record<string, string> = config.channelMode === "remote" && taskChannelId ? { "X-Model-Channel-ID": taskChannelId } : {};
    const tokenHeaders = { ...aiHeaders(config), ...taskChannelHeader };
    const jsonHeaders = { ...aiHeaders(config, "application/json"), ...taskChannelHeader };
    const meta = { nodeId: options.nodeId || "", source: options.source || "canvas", sourceId: options.sourceId || "", clientTaskId: options.clientTaskId || "", prompt, channelId: taskChannelId };
    if (references.length && isAgnesImageModel(config.model)) {
        const imageUrls = await Promise.all(
            references.map(async (ref) => {
                const resolvedUrl = await resolveImageUrl(ref.storageKey, "");
                for (const url of [ref.dataUrl, ref.url, resolvedUrl]) {
                    const publicUrl = publicHttpUrl(url);
                    if (publicUrl) return publicUrl;
                }
                return imageToDataUrl(ref);
            }),
        );
        const body: Record<string, unknown> = {
            model: config.model,
            prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
            extra_body: { image: imageUrls },
        };
        applyAgnesImageSize(body, config, params);
        return {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ endpoint: "/images/generations", ...meta, request: body }),
        };
    }
    if (config.apiMode === "responses" && !isZhipuImageModel(config.model)) {
        const inputImageDataUrls = references.length ? await Promise.all(references.map((image) => imageToDataUrl(image))) : [];
        const body: Record<string, unknown> = {
            model: config.model,
            input: createResponsesInput(config, withSystemPrompt(config, prompt), inputImageDataUrls),
            tools: [createResponsesImageTool(config, params, inputImageDataUrls.length > 0)],
            tool_choice: "required",
        };
        if (config.streamImages) body.stream = true;
        return {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ endpoint: "/responses", ...meta, request: body }),
        };
    }
    if (references.length && isGrokImageModel(config.model)) {
        const body = await createGrokImageEditBody(config, prompt, references, params);
        return {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ endpoint: "/images/edits", ...meta, request: body }),
        };
    }
    if (references.length) {
        const formData = new FormData();
        formData.set("_canvas_endpoint", "/images/edits");
        formData.set("_canvas_source", meta.source);
        formData.set("_canvas_node_id", meta.nodeId);
        formData.set("_canvas_source_id", meta.sourceId);
        formData.set("_canvas_task_id", meta.clientTaskId);
        formData.set("_canvas_prompt", meta.prompt);
        if (meta.channelId) formData.set("_canvas_channel_id", meta.channelId);
        formData.set("model", config.model);
        formData.set("prompt", withPromptGuard(config, withSystemPrompt(config, prompt)));
        if (params.n > 1) formData.set("n", String(params.n));
        if (params.quality && !config.codexCli) formData.set("quality", params.quality);
        if (config.responseFormatB64Json) formData.set("response_format", "b64_json");
        if (config.streamImages) {
            formData.set("stream", "true");
            formData.set("partial_images", String(params.streamPartialImages));
        }
        if (params.size) formData.set("size", params.size);
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        files.forEach((file) => formData.append("image", file));
        return { method: "POST", headers: tokenHeaders, body: formData };
    }
    if (isAgnesImageModel(config.model)) {
        const body: Record<string, unknown> = {
            model: config.model,
            prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        };
        applyAgnesImageSize(body, config, params);
        return {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ endpoint: "/images/generations", ...meta, request: body }),
        };
    }
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
    };
    applyImageGenerationParams(body, config, params);
    applyImageGenerationOptions(body, config, params);
    return {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ endpoint: "/images/generations", ...meta, request: body }),
    };
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
    let buffer = "";
    let answer = "";
    let processedLength = 0;

    try {
        const response = await axios.post(
            aiApiUrl(config, "/chat/completions"),
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                } as Record<string, string>,
                responseType: "text",
                timeout: IMAGE_REQUEST_TIMEOUT_SECONDS * 1000,
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    const channel = localChannelForActiveModel(config);
    if (isMimoChannel(channel || { baseUrl: config.baseUrl })) return [...mimoModels];
    try {
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
            timeout: IMAGE_REQUEST_TIMEOUT_SECONDS * 1000,
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
function isAgnesImageModel(model: string) {
    const m = model.toLowerCase().replace(/[\s_]+/g, "-");
    return m.startsWith("agnes-image") || m.startsWith("agens-image");
}

function isAgnesImage21Model(model: string) {
    return model.toLowerCase().replace(/[\s_]+/g, "-") === "agnes-image-2.1-flash";
}

function normalizeAgnesImage21Ratio(value: string) {
    const ratio = value.trim().toLowerCase();
    if (["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"].includes(ratio)) {
        return ratio;
    }
    if (ratio === "2048x2048") return "1:1";
    if (ratio === "2048x1152" || ratio === "3840x2160") return "16:9";
    if (ratio === "1152x2048" || ratio === "2160x3840") return "9:16";
    if (ratio === "3136x1344" || ratio === "6272x2688") return "21:9";
    return "1:1";
}

function applyAgnesImageSize(
    body: Record<string, unknown>,
    config: AiConfig,
    params: ImageRequestParams,
) {
    if (!isAgnesImage21Model(config.model)) {
        if (params.size) body.size = params.size;
        return;
    }
    body.size = ({
        auto: "1K",
        low: "2K",
        medium: "3K",
        high: "4K",
    } as Record<string, string>)[params.quality] || "1K";
    body.ratio = normalizeAgnesImage21Ratio(config.size);
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

async function requestAgnesImageEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = IMAGE_MIME;

    // 获取所有参考图的公共 HTTP 链接或降级为 base64 数组，完美对齐 extra_body.image
    const imageUrls = await Promise.all(
        references.map(async (ref) => {
            const resolvedUrl = await resolveImageUrl(ref.storageKey, "");
            for (const url of [ref.dataUrl, ref.url, resolvedUrl]) {
                const publicUrl = publicHttpUrl(url);
                if (publicUrl) return publicUrl;
            }
            return imageToDataUrl(ref);
        })
    );

    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        extra_body: {
            image: imageUrls, // 👈 核心对齐：官方文档参考图参数 extra_body.image 数组
        },
    };
    applyAgnesImageSize(body, config, params);

    return requestAndParseImages(
        config,
        "/images/generations", // 核心对齐：官方图生图同样使用 /images/generations 接口
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            const images = parseImagePayload(payload, mime);
            return { images, responseBody: stringifyLogPayload(payload) };
        },
    );
}

export async function listCanvasImageTasks(config: AiConfig, sources: Array<"image-workbench" | "workflow" | "canvas"> = []) {
    if (!usesAccountProxy(config)) return [];
    const query = sources.length ? `?${sources.map((source) => `source=${encodeURIComponent(source)}`).join("&")}` : "";
    const response = await fetch(`/api/v1/canvas/image-tasks${query}`, {
        headers: aiHeaders(config),
    });
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "读取图片任务失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasImageTask[] };
    if (payload.code !== 0 || !Array.isArray(payload.data)) throw new ImageRequestError(payload.msg || "读取图片任务失败", payload);
    return payload.data;
}

export async function batchCanvasImageTaskStatus(config: AiConfig, ids: string[]) {
    const taskIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!usesAccountProxy(config) || !taskIds.length) return [];
    const response = await fetch("/api/v1/canvas/image-tasks/status", {
        method: "POST",
        headers: aiHeaders(config, "application/json"),
        body: JSON.stringify({ ids: taskIds }),
    });
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "读取图片任务失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasImageTask[] };
    if (payload.code !== 0 || !Array.isArray(payload.data)) throw new ImageRequestError(payload.msg || "读取图片任务失败", payload);
    return payload.data;
}

export async function deleteCanvasImageTask(config: AiConfig, task?: CanvasImageTask | null) {
    if (!usesAccountProxy(config) || !task?.id) return;
    const response = await fetch(`/api/v1/canvas/image-tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
        headers: aiHeaders(config),
    });
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "删除图片任务失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as { code?: number; msg?: string };
    if (payload.code !== 0) throw new ImageRequestError(payload.msg || "删除图片任务失败", payload);
}
