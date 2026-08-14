import {
    canUseGlobalStorage,
    getImageBlob,
    getProxyUrl,
    loadStorageConfig,
    loadUserStorageProvider,
    resolveImageUrl,
    setImageBlob,
    uploadImage,
    uploadRemoteImageToServer,
} from "@/services/image-storage";
import {
    getMediaBlob,
    resolveMediaUrl,
    setMediaBlob,
    uploadMediaBlob,
    uploadRemoteMediaToServer,
} from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasAssistantSession, CanvasNodeData, CanvasNodeMetadata } from "../types";
import { CanvasNodeType } from "../types";
import { isCanvasImageNodeType } from "./canvas-panorama";

export type CanvasMediaStatus = "ok" | "local-only" | "broken";

export type CanvasMediaRef = {
    content?: string;
    storageKey?: string;
    mediaStatus?: CanvasMediaStatus;
    mediaError?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type RepairCanvasMediaResult = {
    nodes: CanvasNodeData[];
    sessions: CanvasAssistantSession[];
    changed: boolean;
    uploaded: number;
    broken: number;
};

function isBlobUrl(value?: string) {
    return Boolean(value && value.startsWith("blob:"));
}

export function isStableMediaUrl(value?: string) {
    if (!value) return false;
    if (isBlobUrl(value)) return false;
    return (
        value.startsWith("http://") ||
        value.startsWith("https://") ||
        value.startsWith("/api/") ||
        value.startsWith("data:")
    );
}

function isHttpUrl(value?: string) {
    return Boolean(value && (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/api/")));
}

function isDataUrl(value?: string) {
    return Boolean(value && value.startsWith("data:"));
}

function isImageStorageKey(key?: string) {
    return Boolean(key && (key.startsWith("image:") || key.startsWith("server:")));
}

function isMediaStorageKey(key?: string) {
    return Boolean(key && (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("audio:") || key.startsWith("asset-") || key.startsWith("server:")));
}

export async function canUploadCanvasMediaToServer() {
    const token = useUserStore.getState().token;
    if (!token) return false;
    const config = await loadStorageConfig().catch(() => null);
    if (!config) return false;
    const userProvider = config.allowUserProvider ? loadUserStorageProvider() : null;
    return canUseGlobalStorage(config) || Boolean(userProvider);
}

/** Sync sanitize for persistence/sync. Never keep blob: in saved JSON. */
export function normalizeCanvasMediaRefForPersistence(ref: CanvasMediaRef): CanvasMediaRef {
    const storageKey = (ref.storageKey || "").trim();
    const content = (ref.content || "").trim();
    if (!isBlobUrl(content)) {
        return {
            ...ref,
            content,
            storageKey,
            mediaStatus: ref.mediaStatus || (isStableMediaUrl(content) || storageKey.startsWith("server:") ? "ok" : storageKey ? "local-only" : content ? "ok" : ref.mediaStatus),
        };
    }
    return {
        ...ref,
        content: "",
        storageKey,
        mediaStatus: storageKey ? "local-only" : "broken",
        mediaError: storageKey ? "本地临时媒体，换域名后不可见" : "媒体仅存于原浏览器本地，已失效",
    };
}

export function sanitizeCanvasNodeForPersistence(node: CanvasNodeData): CanvasNodeData {
    const metadata = node.metadata || {};
    const next = normalizeCanvasMediaRefForPersistence({
        content: metadata.content,
        storageKey: metadata.storageKey,
        mediaStatus: metadata.mediaStatus,
        mediaError: metadata.mediaError,
        mimeType: metadata.mimeType,
        bytes: metadata.bytes,
        width: metadata.naturalWidth,
        height: metadata.naturalHeight,
        durationMs: metadata.durationMs,
    });
    if (
        next.content === (metadata.content || "") &&
        next.storageKey === (metadata.storageKey || "") &&
        next.mediaStatus === metadata.mediaStatus &&
        next.mediaError === metadata.mediaError
    ) {
        return node;
    }
    return {
        ...node,
        metadata: {
            ...metadata,
            content: next.content || "",
            storageKey: next.storageKey || "",
            mediaStatus: next.mediaStatus,
            mediaError: next.mediaError,
        },
    };
}

export function sanitizeCanvasNodesForPersistence(nodes: CanvasNodeData[] = []) {
    return nodes.map(sanitizeCanvasNodeForPersistence);
}

export function sanitizeCanvasSessionsForPersistence(sessions: CanvasAssistantSession[] = []) {
    return sessions.map((session) => ({
        ...session,
        messages: (session.messages || []).map((message) => ({
            ...message,
            images: (message.images || []).map((image) => ({
                ...image,
                dataUrl: isBlobUrl(image.dataUrl) ? "" : image.dataUrl,
            })),
            references: (message.references || []).map((reference) => ({
                ...reference,
                dataUrl: isBlobUrl(reference.dataUrl) ? "" : reference.dataUrl,
                url: isBlobUrl(reference.url) ? "" : reference.url,
            })),
        })),
    }));
}

function displayUrl(url: string) {
    if (!url) return "";
    if (isHttpUrl(url)) return getProxyUrl(url);
    return url;
}

async function tryUploadImageSource(source: string | Blob, filename: string) {
    if (typeof source === "string" && isHttpUrl(source)) {
        try {
            return await uploadRemoteImageToServer(source, filename);
        } catch {
            // fall through to generic uploadImage which can still store locally
        }
    }
    return uploadImage(source);
}

async function tryUploadMediaSource(source: string | Blob, filename: string) {
    if (typeof source === "string" && isHttpUrl(source)) {
        try {
            return await uploadRemoteMediaToServer(source, filename);
        } catch {
            // ignore and try blob path below
        }
    }
    if (typeof source !== "string") {
        return uploadMediaBlob(source, filename);
    }
    if (isDataUrl(source) || isBlobUrl(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`读取媒体失败：${response.status}`);
        return uploadMediaBlob(await response.blob(), filename);
    }
    throw new Error("无法上传该媒体");
}

/**
 * Repair one media ref for display + optional cloud upload.
 * Priority: server:/stable http(s) -> local IndexedDB upload/display -> broken.
 */
export async function repairCanvasMediaRef(
    ref: CanvasMediaRef,
    kind: "image" | "media",
    options: { allowUpload?: boolean; filename?: string } = {},
): Promise<{ ref: CanvasMediaRef; changed: boolean; uploaded: boolean }> {
    const allowUpload = options.allowUpload ?? true;
    const filename = options.filename || (kind === "image" ? "canvas-image.png" : "canvas-media.bin");
    const originalContent = (ref.content || "").trim();
    const originalKey = (ref.storageKey || "").trim();
    let content = originalContent;
    let storageKey = originalKey;
    let mediaStatus: CanvasMediaStatus = ref.mediaStatus || "ok";
    let mediaError = ref.mediaError;
    let uploaded = false;
    const canUpload = allowUpload && (await canUploadCanvasMediaToServer());

    // 1) Prefer stable remote/API URL already on the node.
    if (isHttpUrl(content) || isDataUrl(content)) {
        if (canUpload && (isDataUrl(content) || (isHttpUrl(content) && !storageKey.startsWith("server:")))) {
            // data: should be uploaded when possible; http can stay as-is unless we want server copy.
            if (isDataUrl(content)) {
                try {
                    const result =
                        kind === "image"
                            ? await tryUploadImageSource(content, filename)
                            : await tryUploadMediaSource(content, filename);
                    content = result.url;
                    storageKey = result.storageKey;
                    uploaded = result.storageKey.startsWith("server:");
                    mediaStatus = uploaded || isHttpUrl(result.url) ? "ok" : "local-only";
                    mediaError = mediaStatus === "local-only" ? "未上云，换域名不可见" : undefined;
                } catch {
                    // keep data url only for same-session; persistence will strip if blob
                    mediaStatus = "local-only";
                    mediaError = "未上云，换域名不可见";
                }
            } else {
                mediaStatus = "ok";
                mediaError = undefined;
                content = displayUrl(content);
            }
        } else {
            mediaStatus = "ok";
            mediaError = undefined;
            content = isHttpUrl(content) ? displayUrl(content) : content;
        }
    } else if (storageKey.startsWith("server:")) {
        const resolved =
            kind === "image"
                ? await resolveImageUrl(storageKey, isHttpUrl(originalContent) ? originalContent : "")
                : await resolveMediaUrl(storageKey, isHttpUrl(originalContent) ? originalContent : "");
        if (resolved) {
            content = resolved;
            mediaStatus = "ok";
            mediaError = undefined;
        } else {
            content = "";
            mediaStatus = "broken";
            mediaError = "云端文件不可用";
        }
    } else if (storageKey && ((kind === "image" && isImageStorageKey(storageKey)) || (kind === "media" && isMediaStorageKey(storageKey)))) {
        const localBlob = kind === "image" ? await getImageBlob(storageKey).catch(() => null) : await getMediaBlob(storageKey).catch(() => null);
        if (localBlob) {
            if (canUpload) {
                try {
                    const result =
                        kind === "image"
                            ? await tryUploadImageSource(localBlob, filename)
                            : await tryUploadMediaSource(localBlob, filename);
                    content = isHttpUrl(result.url) ? displayUrl(result.url) : result.url;
                    storageKey = result.storageKey;
                    uploaded = result.storageKey.startsWith("server:");
                    mediaStatus = uploaded || isHttpUrl(result.url) ? "ok" : "local-only";
                    mediaError = mediaStatus === "local-only" ? "未上云，换域名不可见" : undefined;
                    // Keep a local cache under server key for snappier reload on this origin.
                    if (uploaded) {
                        if (kind === "image") await setImageBlob(storageKey, localBlob).catch(() => undefined);
                        else await setMediaBlob(storageKey, localBlob).catch(() => undefined);
                    }
                } catch {
                    const resolved =
                        kind === "image" ? await resolveImageUrl(storageKey, "") : await resolveMediaUrl(storageKey, "");
                    content = resolved;
                    mediaStatus = "local-only";
                    mediaError = "未上云，换域名不可见";
                }
            } else {
                const resolved =
                    kind === "image" ? await resolveImageUrl(storageKey, "") : await resolveMediaUrl(storageKey, "");
                content = resolved;
                mediaStatus = "local-only";
                mediaError = "未上云，换域名不可见";
            }
        } else if (isHttpUrl(originalContent)) {
            content = displayUrl(originalContent);
            mediaStatus = "ok";
            mediaError = undefined;
        } else {
            content = "";
            mediaStatus = "broken";
            mediaError = "本地缓存丢失；若无法从生成任务恢复，请重新生成";
        }
    } else if (isBlobUrl(content)) {
        // Foreign/local blob without readable storageKey cannot be recovered on another origin.
        content = "";
        mediaStatus = "broken";
        mediaError = "本地缓存丢失；若无法从生成任务恢复，请重新生成";
    } else if (!content && !storageKey) {
        mediaStatus = ref.mediaStatus;
        mediaError = ref.mediaError;
    }

    // Never return foreign blob URLs.
    if (isBlobUrl(content) && typeof window !== "undefined") {
        try {
            const blobOrigin = new URL(content).origin;
            if (blobOrigin !== "null" && blobOrigin !== window.location.origin) {
                content = "";
                mediaStatus = "broken";
                mediaError = "本地缓存丢失；若无法从生成任务恢复，请重新生成";
            }
        } catch {
            content = "";
            mediaStatus = "broken";
            mediaError = "本地缓存丢失；若无法从生成任务恢复，请重新生成";
        }
    }

    const next: CanvasMediaRef = {
        ...ref,
        content: content || "",
        storageKey: storageKey || "",
        mediaStatus,
        mediaError,
    };
    const changed =
        next.content !== originalContent ||
        next.storageKey !== originalKey ||
        next.mediaStatus !== ref.mediaStatus ||
        next.mediaError !== ref.mediaError;
    return { ref: next, changed, uploaded };
}

function applyRefToMetadata(metadata: CanvasNodeMetadata | undefined, ref: CanvasMediaRef): CanvasNodeMetadata {
    return {
        ...(metadata || {}),
        content: ref.content || "",
        storageKey: ref.storageKey || "",
        mediaStatus: ref.mediaStatus,
        mediaError: ref.mediaError,
        mimeType: ref.mimeType || metadata?.mimeType,
        bytes: ref.bytes ?? metadata?.bytes,
        naturalWidth: ref.width ?? metadata?.naturalWidth,
        naturalHeight: ref.height ?? metadata?.naturalHeight,
        durationMs: ref.durationMs ?? metadata?.durationMs,
    };
}

function nodeHasDisplayableMedia(metadata: CanvasNodeMetadata | undefined) {
    const content = (metadata?.content || "").trim();
    const storageKey = (metadata?.storageKey || "").trim();
    if (storageKey.startsWith("server:")) return true;
    if (isStableMediaUrl(content) && !isBlobUrl(content)) return true;
    return false;
}

function collectImageTaskIds(nodes: CanvasNodeData[]) {
    const ids: string[] = [];
    for (const node of nodes) {
        if (!isCanvasImageNodeType(node.type)) continue;
        if (nodeHasDisplayableMedia(node.metadata)) continue;
        const id = (node.metadata?.imageTaskResultId || node.metadata?.imageTaskId || "").trim();
        if (id) ids.push(id);
    }
    return Array.from(new Set(ids));
}

async function authJsonHeaders() {
    const token = useUserStore.getState().token;
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function batchFetchImageTasks(ids: string[]) {
    const headers = await authJsonHeaders();
    if (!headers || !ids.length) return new Map<string, Record<string, any>>();
    const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    const map = new Map<string, Record<string, any>>();
    // Chunk to avoid oversized payloads.
    for (let i = 0; i < unique.length; i += 50) {
        const chunk = unique.slice(i, i + 50);
        try {
            const response = await fetch("/api/v1/canvas/image-tasks/status", {
                method: "POST",
                headers,
                body: JSON.stringify({ ids: chunk }),
            });
            if (!response.ok) continue;
            const payload = (await response.json().catch(() => null)) as { code?: number; data?: any[] } | null;
            if (payload?.code !== 0 || !Array.isArray(payload.data)) continue;
            for (const task of payload.data) {
                const id = String(task?.id || "").trim();
                if (id) map.set(id, task);
            }
        } catch {
            // ignore chunk failures; remaining nodes stay broken
        }
    }
    return map;
}

async function fetchVideoTask(taskId: string) {
    const headers = await authJsonHeaders();
    if (!headers || !taskId) return null;
    try {
        // Prefer account video-task record (has video_url after completion).
        const listResponse = await fetch("/api/v1/video-tasks", { headers });
        if (listResponse.ok) {
            const listPayload = (await listResponse.json().catch(() => null)) as { code?: number; data?: any[] } | null;
            if (listPayload?.code === 0 && Array.isArray(listPayload.data)) {
                const hit = listPayload.data.find((item) => {
                    const id = String(item?.id || item?.task_id || "").trim();
                    const upstream = String(item?.upstreamTaskId || item?.upstream_task_id || item?.video_id || "").trim();
                    return id === taskId || upstream === taskId;
                });
                if (hit) return hit;
            }
        }
        const response = await fetch(`/api/v1/videos/${encodeURIComponent(taskId)}`, { headers });
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => null)) as { code?: number; data?: any } | null;
        if (payload?.code === 0 && payload.data) return payload.data;
        // Some handlers return the task object directly under data-less body.
        if (payload && !("code" in payload)) return payload as any;
        return payload?.data || null;
    } catch {
        return null;
    }
}

async function fetchAudioTask(taskId: string) {
    const headers = await authJsonHeaders();
    if (!headers || !taskId) return null;
    try {
        const response = await fetch(`/api/v1/canvas/audio-tasks/${encodeURIComponent(taskId)}`, { headers });
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => null)) as { code?: number; data?: any } | null;
        if (payload?.code !== 0 || !payload.data) return null;
        return payload.data;
    } catch {
        return null;
    }
}

function taskMediaUrl(task: Record<string, any> | null | undefined, kind: "image" | "video" | "audio") {
    if (!task) return { url: "", storageKey: "" };
    const status = String(task.status || "").toLowerCase();
    const failed = ["failed", "fail", "error", "cancelled", "canceled"].includes(status);
    if (failed) return { url: "", storageKey: "" };
    const storageKey = String(task.storageKey || task.storage_key || "").trim();
    if (kind === "image") {
        const urls = [
            task.image_url,
            task.url,
            ...(Array.isArray(task.image_urls) ? task.image_urls : []),
        ]
            .map((item) => String(item || "").trim())
            .filter(Boolean);
        return { url: urls[0] || "", storageKey };
    }
    if (kind === "video") {
        const url = String(task.video_url || task.url || task.videoUrl || "").trim();
        return { url, storageKey };
    }
    const url = String(task.audio_url || task.url || "").trim();
    return { url, storageKey };
}

function isTaskCompletedEnough(task: Record<string, any> | null | undefined, url: string) {
    if (!task) return false;
    if (url) return true;
    const status = String(task.status || "").toLowerCase();
    return ["completed", "complete", "done", "succeeded", "success"].includes(status);
}

async function backfillNodeFromTasks(
    node: CanvasNodeData,
    imageTasks: Map<string, Record<string, any>>,
): Promise<{ node: CanvasNodeData; changed: boolean }> {
    const metadata = node.metadata || {};
    if (nodeHasDisplayableMedia(metadata)) return { node, changed: false };

    if (isCanvasImageNodeType(node.type)) {
        const taskId = (metadata.imageTaskResultId || metadata.imageTaskId || "").trim();
        if (!taskId) return { node, changed: false };
        const task = imageTasks.get(taskId);
        const media = taskMediaUrl(task, "image");
        if (!isTaskCompletedEnough(task, media.url) || (!media.url && !media.storageKey.startsWith("server:"))) {
            return { node, changed: false };
        }
        const fields = mediaFieldsFromStableSource({
            url: media.url,
            storageKey: media.storageKey,
            mimeType: String(task?.mimeType || metadata.mimeType || "image/png"),
            bytes: Number(task?.bytes || metadata.bytes || 0) || undefined,
            width: Number(task?.width || metadata.naturalWidth || 0) || undefined,
            height: Number(task?.height || metadata.naturalHeight || 0) || undefined,
        });
        // Prefer proxied display for remote http(s).
        if (isHttpUrl(fields.content)) fields.content = displayUrl(fields.content || "");
        if (fields.storageKey?.startsWith("server:") && !fields.content) {
            const resolved = await resolveImageUrl(fields.storageKey, "");
            fields.content = resolved || fields.content;
        }
        return {
            node: {
                ...node,
                metadata: {
                    ...metadata,
                    ...fields,
                    status: "success",
                    mediaStatus: fields.mediaStatus || "ok",
                    mediaError: undefined,
                    imageTaskId: metadata.imageTaskId || taskId,
                    imageTaskResultId: metadata.imageTaskResultId || taskId,
                },
            },
            changed: true,
        };
    }

    if (node.type === CanvasNodeType.Video) {
        const taskId = (metadata.videoTaskId || "").trim();
        if (!taskId) return { node, changed: false };
        const task = await fetchVideoTask(taskId);
        const media = taskMediaUrl(task, "video");
        if (!media.url && !media.storageKey.startsWith("server:")) return { node, changed: false };
        const fields = mediaFieldsFromStableSource({
            url: media.url,
            storageKey: media.storageKey,
            mimeType: metadata.mimeType || "video/mp4",
        });
        if (isHttpUrl(fields.content)) fields.content = displayUrl(fields.content || "");
        if (fields.storageKey?.startsWith("server:") && !fields.content) {
            fields.content = (await resolveMediaUrl(fields.storageKey, "")) || "";
        }
        return {
            node: {
                ...node,
                metadata: {
                    ...metadata,
                    ...fields,
                    status: "success",
                    mediaStatus: fields.mediaStatus || "ok",
                    mediaError: undefined,
                    videoTaskId: metadata.videoTaskId || taskId,
                },
            },
            changed: true,
        };
    }

    if (node.type === CanvasNodeType.Audio) {
        const taskId = (metadata.audioTaskResultId || metadata.audioTaskId || "").trim();
        if (!taskId) return { node, changed: false };
        const task = await fetchAudioTask(taskId);
        const media = taskMediaUrl(task, "audio");
        if (!media.url && !media.storageKey.startsWith("server:")) return { node, changed: false };
        const fields = mediaFieldsFromStableSource({
            url: media.url,
            storageKey: media.storageKey,
            mimeType: String(task?.mimeType || metadata.mimeType || "audio/mpeg"),
            bytes: Number(task?.bytes || metadata.bytes || 0) || undefined,
        });
        if (isHttpUrl(fields.content)) fields.content = displayUrl(fields.content || "");
        if (fields.storageKey?.startsWith("server:") && !fields.content) {
            fields.content = (await resolveMediaUrl(fields.storageKey, "")) || "";
        }
        return {
            node: {
                ...node,
                metadata: {
                    ...metadata,
                    ...fields,
                    status: "success",
                    mediaStatus: fields.mediaStatus || "ok",
                    mediaError: undefined,
                    audioTaskId: metadata.audioTaskId || taskId,
                    audioTaskResultId: metadata.audioTaskResultId || taskId,
                },
            },
            changed: true,
        };
    }

    return { node, changed: false };
}

export async function repairCanvasNodeMedia(node: CanvasNodeData, options: { allowUpload?: boolean } = {}) {
    const metadata = node.metadata || {};
    const isImage = isCanvasImageNodeType(node.type);
    const isMedia = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    if (!isImage && !isMedia) return { node, changed: false, uploaded: false };

    // Skip empty idle placeholders that were never generated.
    const hasTask =
        Boolean(metadata.imageTaskId || metadata.imageTaskResultId || metadata.videoTaskId || metadata.audioTaskId || metadata.audioTaskResultId);
    if (!metadata.content && !metadata.storageKey && metadata.status !== "success" && !hasTask) {
        return { node, changed: false, uploaded: false };
    }

    const repaired = await repairCanvasMediaRef(
        {
            content: metadata.content,
            storageKey: metadata.storageKey,
            mediaStatus: metadata.mediaStatus,
            mediaError: metadata.mediaError,
            mimeType: metadata.mimeType,
            bytes: metadata.bytes,
            width: metadata.naturalWidth,
            height: metadata.naturalHeight,
            durationMs: metadata.durationMs,
        },
        isImage ? "image" : "media",
        {
            allowUpload: options.allowUpload,
            filename: `canvas-${node.type}-${node.id}.${isImage ? "png" : node.type === CanvasNodeType.Audio ? "mp3" : "mp4"}`,
        },
    );
    if (!repaired.changed) return { node, changed: false, uploaded: repaired.uploaded };
    return {
        node: { ...node, metadata: applyRefToMetadata(metadata, repaired.ref) },
        changed: true,
        uploaded: repaired.uploaded,
    };
}

export async function repairCanvasNodesMedia(nodes: CanvasNodeData[], options: { allowUpload?: boolean } = {}) {
    let changed = false;
    let uploaded = 0;
    let broken = 0;
    let next: CanvasNodeData[] = [];
    for (const node of nodes) {
        const result = await repairCanvasNodeMedia(node, options);
        next.push(result.node);
        if (result.changed) changed = true;
        if (result.uploaded) uploaded += 1;
    }

    // Task backfill for nodes still missing portable media.
    const imageTaskIds = collectImageTaskIds(next);
    const imageTasks = await batchFetchImageTasks(imageTaskIds);
    const afterBackfill: CanvasNodeData[] = [];
    for (const node of next) {
        if (nodeHasDisplayableMedia(node.metadata)) {
            afterBackfill.push(node);
            continue;
        }
        const result = await backfillNodeFromTasks(node, imageTasks);
        if (result.changed) changed = true;
        afterBackfill.push(result.node);
    }
    next = afterBackfill;

    for (const node of next) {
        if (node.metadata?.mediaStatus === "broken" || (!nodeHasDisplayableMedia(node.metadata) && (node.metadata?.status === "success" || node.metadata?.mediaStatus === "broken"))) {
            // Ensure explicit broken mark when still empty after all recovery paths.
            if (!nodeHasDisplayableMedia(node.metadata) && (node.metadata?.status === "success" || node.metadata?.imageTaskId || node.metadata?.videoTaskId || node.metadata?.audioTaskId)) {
                if (node.metadata?.mediaStatus !== "broken") {
                    changed = true;
                    node.metadata = {
                        ...node.metadata,
                        content: "",
                        mediaStatus: "broken",
                        mediaError: node.metadata?.mediaError || "本地缓存丢失，任务恢复失败，请重新生成",
                    };
                }
                broken += 1;
            } else if (node.metadata?.mediaStatus === "broken") {
                broken += 1;
            }
        }
    }
    return { nodes: next, changed, uploaded, broken };
}

export async function repairCanvasSessionsMedia(sessions: CanvasAssistantSession[], options: { allowUpload?: boolean } = {}) {
    let changed = false;
    let uploaded = 0;
    const nextSessions: CanvasAssistantSession[] = [];
    for (const session of sessions) {
        const messages = [];
        for (const message of session.messages || []) {
            const images = [];
            for (const image of message.images || []) {
                const repaired = await repairCanvasMediaRef(
                    { content: image.dataUrl, storageKey: image.storageKey },
                    "image",
                    { allowUpload: options.allowUpload, filename: "assistant-image.png" },
                );
                if (repaired.changed) changed = true;
                if (repaired.uploaded) uploaded += 1;
                images.push({
                    ...image,
                    dataUrl: repaired.ref.content || image.dataUrl || "",
                    storageKey: repaired.ref.storageKey || image.storageKey,
                });
            }
            const references = [];
            for (const reference of message.references || []) {
                const kind = reference.kind === "image" ? "image" : "media";
                const repaired = await repairCanvasMediaRef(
                    {
                        content: reference.dataUrl || reference.url,
                        storageKey: reference.storageKey,
                    },
                    kind as "image" | "media",
                    { allowUpload: options.allowUpload, filename: `assistant-ref-${reference.kind || "media"}` },
                );
                if (repaired.changed) changed = true;
                if (repaired.uploaded) uploaded += 1;
                references.push({
                    ...reference,
                    dataUrl: reference.kind === "image" ? repaired.ref.content || "" : reference.dataUrl,
                    url: reference.kind === "image" ? reference.url : repaired.ref.content || reference.url || "",
                    storageKey: repaired.ref.storageKey || reference.storageKey,
                });
            }
            messages.push({ ...message, images, references });
        }
        nextSessions.push({ ...session, messages });
    }
    return { sessions: nextSessions, changed, uploaded };
}

export async function repairCanvasProjectMedia(
    nodes: CanvasNodeData[],
    sessions: CanvasAssistantSession[] = [],
    options: { allowUpload?: boolean } = {},
): Promise<RepairCanvasMediaResult> {
    const nodeResult = await repairCanvasNodesMedia(nodes, options);
    const sessionResult = await repairCanvasSessionsMedia(sessions, options);
    return {
        nodes: nodeResult.nodes,
        sessions: sessionResult.sessions,
        changed: nodeResult.changed || sessionResult.changed,
        uploaded: nodeResult.uploaded + sessionResult.uploaded,
        broken: nodeResult.broken,
    };
}

/** Prefer stable URL for generation/import write paths. */
export function mediaFieldsFromStableSource(input: {
    url?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
}): Pick<CanvasNodeMetadata, "content" | "storageKey" | "mediaStatus" | "mediaError" | "mimeType" | "bytes" | "naturalWidth" | "naturalHeight" | "durationMs"> {
    const url = (input.url || "").trim();
    const storageKey = (input.storageKey || "").trim();
    if (isHttpUrl(url) || storageKey.startsWith("server:")) {
        return {
            content: isHttpUrl(url) ? url : "",
            storageKey,
            mediaStatus: "ok",
            mediaError: undefined,
            mimeType: input.mimeType,
            bytes: input.bytes,
            naturalWidth: input.width,
            naturalHeight: input.height,
            durationMs: input.durationMs,
        };
    }
    if (isDataUrl(url)) {
        return {
            content: url,
            storageKey,
            mediaStatus: storageKey.startsWith("server:") ? "ok" : "local-only",
            mediaError: storageKey.startsWith("server:") ? undefined : "未上云，换域名不可见",
            mimeType: input.mimeType,
            bytes: input.bytes,
            naturalWidth: input.width,
            naturalHeight: input.height,
            durationMs: input.durationMs,
        };
    }
    if (isBlobUrl(url)) {
        return {
            // Keep blob only for in-memory same-origin preview; persistence sanitizer strips it.
            content: url,
            storageKey,
            mediaStatus: storageKey ? "local-only" : "broken",
            mediaError: storageKey ? "未上云，换域名不可见" : "媒体仅存于原浏览器本地，已失效",
            mimeType: input.mimeType,
            bytes: input.bytes,
            naturalWidth: input.width,
            naturalHeight: input.height,
            durationMs: input.durationMs,
        };
    }
    return {
        content: url,
        storageKey,
        mediaStatus: url || storageKey ? "ok" : undefined,
        mimeType: input.mimeType,
        bytes: input.bytes,
        naturalWidth: input.width,
        naturalHeight: input.height,
        durationMs: input.durationMs,
    };
}
