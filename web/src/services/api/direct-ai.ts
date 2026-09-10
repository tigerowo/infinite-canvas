import { apiPost } from "@/services/api/request";
import { resolveMediaUrl, uploadRemoteMediaToServer } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { getStorageObjectInfo } from "@/services/api/storage";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { buildApiUrl, localChannelForActiveModel, type AiConfig, type DirectAIProvider } from "@/stores/use-config-store";
import { directProtocolAdapters } from "./protocols/direct-registry";
import { isPlainRecord, readPath, readString } from "./protocols/shared";
import type { DirectProtocolAdapter, DirectVideoResponse } from "./protocols/types";

type DirectRequestBody = Record<string, unknown> | FormData;
type DirectReferenceKind = "image" | "video" | "audio";
type DirectReference = { marker: string; file: File; kind: DirectReferenceKind };
type DirectUploadSpec = { url: string; fileField: string; fileNameField?: string; extraFields?: Record<string, string>; responsePaths: string[] };
type DirectRequestPlan = { provider: DirectAIProvider; url: string; contentType: string; body: unknown; uploads?: Partial<Record<DirectReferenceKind, DirectUploadSpec>> };
type DirectImageResponse = { created?: number; data: Array<{ url?: string; b64_json?: string }> };
type SerializedDirectBody = { body: unknown; references: DirectReference[] };

const DIRECT_REFERENCE_HOST = "direct-reference.invalid";
const DIRECT_IMAGE_POLL_INTERVAL_MS = 2000;

export async function autoDLReferenceURL(reference: ReferenceImage | ReferenceVideo | ReferenceAudio) {
    for (const value of [reference.url, "dataUrl" in reference ? reference.dataUrl : ""]) {
        const url = publicReferenceURL(value);
        if (url) return url;
    }
    const storedUrl = await storedReferenceURL(reference.storageKey);
    if (storedUrl) return storedUrl;
    if (reference.storageKey?.startsWith("server:")) throw new Error("AutoDL 参考素材需要云存储提供可公开访问的地址");
    const source = "dataUrl" in reference
        ? await resolveImageUrl(reference.storageKey, reference.dataUrl || reference.url || "")
        : await resolveMediaUrl(reference.storageKey, reference.url);
    if (!source) throw new Error("参考素材不可用");
    const uploaded = await uploadRemoteMediaToServer(source, reference.name || "reference");
    const url = publicReferenceURL(uploaded.url) || await storedReferenceURL(uploaded.storageKey);
    if (!url) throw new Error("AutoDL 参考素材需要云存储提供可公开访问的地址");
    return url;
}

async function storedReferenceURL(storageKey?: string) {
    if (!storageKey?.startsWith("server:") || storageKey.startsWith("server:webdav:")) return "";
    const info = await getStorageObjectInfo(storageKey.slice("server:".length));
    return publicReferenceURL(info.publicUrl);
}

function publicReferenceURL(value?: string) {
    if (!value || !/^https?:\/\//i.test(value)) return "";
    try {
        const url = new URL(value);
        return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "" : url.href;
    } catch {
        return "";
    }
}

export async function requestDirectImages(config: AiConfig, provider: DirectAIProvider, endpoint: "/images/generations" | "/images/edits", body: DirectRequestBody, timeoutSeconds: number): Promise<DirectImageResponse> {
    const startedAt = Date.now();
    const { plan, requestBody, apiKey, protocol } = await prepareDirectRequest(config, provider, endpoint, body);
    const created = await requestDirectJSON(protocol, plan.url, apiKey, plan.contentType, requestBody, remainingTimeoutMs(startedAt, timeoutSeconds));
    const directUrls = protocol.readCreatedImageURLs?.(created) || [];
    if (directUrls.length) return directImageResponse(directUrls);
    const taskId = protocol.readTaskId(created);
    if (!taskId) throw new Error(protocol.readError(created) || "图片接口没有返回结果或任务 ID");

    for (;;) {
        const waitMs = Math.min(DIRECT_IMAGE_POLL_INTERVAL_MS, remainingTimeoutMs(startedAt, timeoutSeconds));
        await delay(waitMs);
        const payload = await requestDirectJSON(protocol, directPollURL(config, protocol, taskId), apiKey, "", undefined, remainingTimeoutMs(startedAt, timeoutSeconds));
        const result = protocol.readImagePoll(payload);
        if (result.error) throw new Error(result.error);
        if (result.urls.length) return directImageResponse(result.urls);
        if (result.done) throw new Error("图片任务已完成但没有返回图片地址");
    }
}

export async function createDirectVideoTask(config: AiConfig, provider: DirectAIProvider, body: DirectRequestBody): Promise<DirectVideoResponse> {
    const { plan, requestBody, apiKey, protocol } = await prepareDirectRequest(config, provider, "/videos", body);
    const payload = await requestDirectJSON(protocol, plan.url, apiKey, plan.contentType, requestBody);
    const taskId = protocol.readTaskId(payload);
    if (!taskId) throw new Error(protocol.readError(payload) || "视频接口没有返回任务 ID");
    return {
        id: taskId,
        task_id: taskId,
        status: protocol.readCreatedVideoStatus(payload),
        model: config.model || config.videoModel,
    };
}

export async function pollDirectVideoTask(config: AiConfig, provider: DirectAIProvider, pollId: string): Promise<DirectVideoResponse> {
    const channel = requireDirectChannel(config);
    const protocol = directProtocolAdapters[provider];
    const payload = await requestDirectJSON(protocol, directPollURL(config, protocol, pollId), channel.apiKey, "", undefined);
    return protocol.readVideoPoll(payload, pollId, config.model || config.videoModel);
}

export async function requestDirectAudioURL(config: AiConfig, provider: DirectAIProvider, body: DirectRequestBody) {
    const startedAt = Date.now();
    const timeoutSeconds = Number(config.timeout) || 600;
    const { plan, requestBody, apiKey, protocol } = await prepareDirectRequest(config, provider, "/audio/speech", body);
    if (!protocol.readAudioPoll) throw new Error("当前协议不支持异步音频");
    const created = await requestDirectJSON(protocol, plan.url, apiKey, plan.contentType, requestBody, remainingTimeoutMs(startedAt, timeoutSeconds));
    const id = protocol.readTaskId(created);
    if (!id) throw new Error(protocol.readError(created) || "音频接口没有返回任务 ID");
    for (;;) {
        await delay(Math.min(DIRECT_IMAGE_POLL_INTERVAL_MS, remainingTimeoutMs(startedAt, timeoutSeconds)));
        const payload = await requestDirectJSON(protocol, directPollURL(config, protocol, id), apiKey, "", undefined, remainingTimeoutMs(startedAt, timeoutSeconds));
        const result = protocol.readAudioPoll(payload);
        if (result.error) throw new Error(result.error);
        if (result.done && result.url) return { id, url: result.url };
    }
}

async function prepareDirectRequest(config: AiConfig, provider: DirectAIProvider, endpoint: "/images/generations" | "/images/edits" | "/videos" | "/audio/speech", body: DirectRequestBody) {
    const channel = requireDirectChannel(config);
    const serialized = await serializeDirectBody(body);
    assertSafeDirectBody(serialized.body);
    const plan = await apiPost<DirectRequestPlan>("/api/ai/direct-request", {
        channel: { protocol: channel.protocol, baseUrl: channel.baseUrl },
        model: config.model || config.videoModel,
        endpoint,
        body: serialized.body,
    });
    if (plan.provider !== provider) throw new Error("前后端渠道识别结果不一致");
    const protocol = directProtocolAdapters[provider];
    const requestBody = await uploadAndReplaceReferences(protocol, plan, serialized.references, channel.apiKey);
    return { plan, requestBody, apiKey: channel.apiKey, protocol };
}

function requireDirectChannel(config: AiConfig) {
    const channel = localChannelForActiveModel(config);
    if (!channel?.baseUrl.trim() || !channel.apiKey.trim()) throw new Error("本地渠道地址或 API Key 不能为空");
    return channel;
}

async function serializeDirectBody(body: DirectRequestBody): Promise<SerializedDirectBody> {
    const references: DirectReference[] = [];
    const runId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const serialize = async (value: unknown, key = ""): Promise<unknown> => {
        if (isFile(value)) return registerDirectReference(value, key, runId, references);
        if (isBlob(value)) return registerDirectReference(new File([value], directReferenceFilename(referenceKind(value.type, key), value.type), { type: value.type || "application/octet-stream" }), key, runId, references);
        if (typeof value === "string" && (isMediaDataURL(value) || value.startsWith("blob:"))) {
            const file = await directReferenceFileFromURL(value, key);
            return registerDirectReference(file, key, runId, references);
        }
        if (Array.isArray(value)) return Promise.all(value.map((item) => serialize(item, key)));
        if (isPlainRecord(value)) {
            const entries = await Promise.all(Object.entries(value).map(async ([entryKey, item]) => [entryKey, await serialize(item, entryKey)] as const));
            return Object.fromEntries(entries);
        }
        return value;
    };

    if (!(body instanceof FormData)) return { body: await serialize(body), references };
    const result: Record<string, unknown> = {};
    const counts = new Map<string, number>();
    for (const [key, value] of body.entries()) {
        let serializedValue: unknown = value;
        if (typeof value === "string") {
            const parsed = parseJSONString(value);
            serializedValue = await serialize(parsed, key);
        } else {
            serializedValue = await serialize(value, key);
        }
        appendDirectFormValue(result, counts, key, serializedValue);
    }
    return { body: result, references };
}

function registerDirectReference(file: File, key: string, runId: string, references: DirectReference[]) {
    const kind = referenceKind(file.type, key);
    const marker = `https://${DIRECT_REFERENCE_HOST}/${runId}/${kind}/${references.length}`;
    references.push({ marker, file, kind });
    return marker;
}

function appendDirectFormValue(result: Record<string, unknown>, counts: Map<string, number>, key: string, value: unknown) {
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    if (count === 0) {
        result[key] = value;
        return;
    }
    if (count === 1) {
        result[key] = [result[key], value];
        return;
    }
    (result[key] as unknown[]).push(value);
}

async function directReferenceFileFromURL(value: string, key: string) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`参考素材读取失败：${response.status}`);
    const blob = await response.blob();
    const type = blob.type || mediaTypeFromDataURL(value) || "application/octet-stream";
    return new File([blob], directReferenceFilename(referenceKind(type, key), type), { type });
}

function directReferenceFilename(kind: DirectReferenceKind, type: string) {
    const extension = type.split("/")[1]?.split(/[;+]/)[0]?.replace("jpeg", "jpg") || (kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3");
    return `reference.${extension}`;
}

function referenceKind(type: string, key: string): DirectReferenceKind {
    const normalizedType = type.toLowerCase();
    const normalizedKey = key.toLowerCase();
    if (normalizedType.startsWith("video/") || normalizedKey.includes("video")) return "video";
    if (normalizedType.startsWith("audio/") || normalizedKey.includes("audio") || normalizedKey.includes("voice")) return "audio";
    return "image";
}

function isFile(value: unknown): value is File {
    return typeof File !== "undefined" && value instanceof File;
}

function isBlob(value: unknown): value is Blob {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

function isMediaDataURL(value: string) {
    return /^data:(image|video|audio)\//i.test(value);
}

function mediaTypeFromDataURL(value: string) {
    return value.match(/^data:([^;,]+)/i)?.[1] || "";
}

function parseJSONString(value: string): unknown {
    const text = value.trim();
    if (!text) return value;
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

function assertSafeDirectBody(value: unknown) {
    if (isFile(value) || isBlob(value)) throw new Error("参考文件不能传给参数转译接口");
    if (typeof value === "string") {
        if (isMediaDataURL(value) || value.startsWith("blob:")) throw new Error("参考文件不能传给参数转译接口");
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(assertSafeDirectBody);
        return;
    }
    if (isPlainRecord(value)) Object.values(value).forEach(assertSafeDirectBody);
}

async function uploadAndReplaceReferences(protocol: DirectProtocolAdapter, plan: DirectRequestPlan, references: DirectReference[], apiKey: string) {
    const retained = references.filter((reference) => containsDirectMarker(plan.body, reference.marker));
    const uploaded = new Map<string, string>();
    await Promise.all(retained.map(async (reference) => {
        const spec = plan.uploads?.[reference.kind];
        if (!spec) throw new Error(`${plan.provider} 不支持上传本地${directReferenceKindName(reference.kind)}`);
        uploaded.set(reference.marker, await uploadDirectReference(protocol, spec, reference.file, apiKey));
    }));
    const replaced = replaceDirectMarkers(plan.body, uploaded);
    if (containsAnyDirectMarker(replaced)) throw new Error("参考素材地址替换失败");
    return replaced;
}

async function uploadDirectReference(protocol: DirectProtocolAdapter, spec: DirectUploadSpec, file: File, apiKey: string) {
    const formData = new FormData();
    formData.append(spec.fileField, file, file.name);
    if (spec.fileNameField) formData.append(spec.fileNameField, file.name);
    Object.entries(spec.extraFields || {}).forEach(([key, value]) => formData.append(key, value));
    const response = await fetch(spec.url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: formData });
    const payload = await readDirectResponse(response);
    if (!response.ok) throw new Error(protocol.readError(payload) || `参考素材上传失败：${response.status}`);
    const error = protocol.readError(payload);
    if (error) throw new Error(error);
    for (const path of spec.responsePaths) {
        const value = readString(readPath(payload, path));
        if (value) return value;
    }
    throw new Error("参考素材上传成功但没有返回文件地址");
}

function containsDirectMarker(value: unknown, marker: string): boolean {
    if (value === marker) return true;
    if (Array.isArray(value)) return value.some((item) => containsDirectMarker(item, marker));
    if (isPlainRecord(value)) return Object.values(value).some((item) => containsDirectMarker(item, marker));
    return false;
}

function containsAnyDirectMarker(value: unknown): boolean {
    if (typeof value === "string") {
        try {
            return new URL(value).hostname === DIRECT_REFERENCE_HOST;
        } catch {
            return false;
        }
    }
    if (Array.isArray(value)) return value.some(containsAnyDirectMarker);
    if (isPlainRecord(value)) return Object.values(value).some(containsAnyDirectMarker);
    return false;
}

function replaceDirectMarkers(value: unknown, uploaded: Map<string, string>): unknown {
    if (typeof value === "string") return uploaded.get(value) || value;
    if (Array.isArray(value)) return value.map((item) => replaceDirectMarkers(item, uploaded));
    if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDirectMarkers(item, uploaded)]));
    return value;
}

async function requestDirectJSON(protocol: DirectProtocolAdapter, url: string, apiKey: string, contentType: string, body?: unknown, timeoutMs?: number) {
    const controller = new AbortController();
    const timeout = timeoutMs ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
        const response = await fetch(url, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                Authorization: protocol.rawAuthorization ? apiKey : `Bearer ${apiKey}`,
                ...(body === undefined ? {} : { "Content-Type": contentType || "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
        });
        const payload = await readDirectResponse(response);
        if (!response.ok) throw new Error(protocol.readError(payload) || `上游请求失败：${response.status}`);
        const error = protocol.readError(payload);
        if (error) throw new Error(error);
        return payload;
    } finally {
        if (timeout) window.clearTimeout(timeout);
    }
}

async function readDirectResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

function directPollURL(config: AiConfig, protocol: DirectProtocolAdapter, taskId: string) {
    const channel = requireDirectChannel(config);
    if (protocol.pollURL) return protocol.pollURL(channel.baseUrl, taskId);
    return buildApiUrl(channel.baseUrl, protocol.pollPath(taskId));
}

function directImageResponse(urls: string[]): DirectImageResponse {
    return { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) };
}

function directReferenceKindName(kind: DirectReferenceKind) {
    if (kind === "video") return "视频";
    if (kind === "audio") return "音频";
    return "图片";
}

function remainingTimeoutMs(startedAt: number, timeoutSeconds: number) {
    const remaining = timeoutSeconds * 1000 - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error(`请求超时（${timeoutSeconds} 秒）`);
    return remaining;
}

function delay(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
