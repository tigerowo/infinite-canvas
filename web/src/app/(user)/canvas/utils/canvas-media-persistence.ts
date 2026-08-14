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

const UPLOAD_CONCURRENCY = 3;

function isBlobUrl(value?: string) {
    return Boolean(value && value.startsWith("blob:"));
}

export function isStableMediaUrl(value?: string) {
    if (!value) return false;
    if (isBlobUrl(value)) return false;
    return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/api/") || value.startsWith("data:");
}

function isHttpUrl(value?: string) {
    return Boolean(value && (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/api/")));
}

function isDataUrl(value?: string) {
    return Boolean(value && value.startsWith("data:"));
}

function isLocalImageKey(key?: string) {
    return Boolean(key && key.startsWith("image:"));
}

function isLocalMediaKey(key?: string) {
    return Boolean(key && (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("audio:") || key.startsWith("asset-media:") || key.startsWith("asset-")));
}

function isServerKey(key?: string) {
    return Boolean(key && key.startsWith("server:"));
}

function serverContentUrl(storageKey?: string) {
    if (!isServerKey(storageKey)) return "";
    const id = String(storageKey).slice("server:".length).trim();
    return id ? `/api/files/${encodeURIComponent(id)}/content` : "";
}

function displayUrl(url: string) {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://")) return getProxyUrl(url);
    return url;
}

function isForeignBlob(content?: string) {
    if (!isBlobUrl(content) || typeof window === "undefined") return false;
    try {
        const origin = new URL(content!).origin;
        return origin !== "null" && origin !== window.location.origin;
    } catch {
        return true;
    }
}

export async function canUploadCanvasMediaToServer() {
    const token = useUserStore.getState().token;
    if (!token) return false;
    const config = await loadStorageConfig().catch(() => null);
    if (!config) return false;
    const userProvider = config.allowUserProvider ? loadUserStorageProvider() : null;
    return canUseGlobalStorage(config) || Boolean(userProvider);
}

export function nodeNeedsCloudUpload(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    if (isServerKey(metadata.storageKey)) return false;
    const content = String(metadata.content || "").trim();
    const key = String(metadata.storageKey || "").trim();
    if (isCanvasImageNodeType(node.type)) {
        return Boolean(key || content);
    }
    if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
        return Boolean(key || content);
    }
    return false;
}

/** Sync sanitize for persistence/sync. Never keep blob: in saved JSON. */
export function normalizeCanvasMediaRefForPersistence(ref: CanvasMediaRef): CanvasMediaRef {
    const storageKey = (ref.storageKey || "").trim();
    let content = (ref.content || "").trim();
    if (isBlobUrl(content) || isDataUrl(content)) {
        content = serverContentUrl(storageKey);
        return {
            ...ref,
            content,
            storageKey,
            mediaStatus: content || isServerKey(storageKey) ? "ok" : storageKey ? "local-only" : "broken",
            mediaError: content || isServerKey(storageKey) ? undefined : storageKey ? "未上云，换浏览器不可见" : "媒体仅存于原浏览器本地，已失效",
        };
    }
    if (isServerKey(storageKey) && !content) {
        content = serverContentUrl(storageKey);
    }
    return {
        ...ref,
        content,
        storageKey,
        mediaStatus: ref.mediaStatus || (isStableMediaUrl(content) || isServerKey(storageKey) ? "ok" : storageKey ? "local-only" : content ? "ok" : ref.mediaStatus),
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
                dataUrl: isBlobUrl(image.dataUrl) || isDataUrl(image.dataUrl) ? (isServerKey(image.storageKey) ? serverContentUrl(image.storageKey) : "") : image.dataUrl,
            })),
            references: (message.references || []).map((reference) => ({
                ...reference,
                dataUrl: isBlobUrl(reference.dataUrl) || isDataUrl(reference.dataUrl) ? (isServerKey(reference.storageKey) ? serverContentUrl(reference.storageKey) : "") : reference.dataUrl,
                url: isBlobUrl(reference.url) ? "" : reference.url,
            })),
        })),
    }));
}

function applyRefToMetadata(metadata: CanvasNodeMetadata, ref: CanvasMediaRef): CanvasNodeMetadata {
    return {
        ...metadata,
        content: ref.content || "",
        storageKey: ref.storageKey || "",
        mediaStatus: ref.mediaStatus,
        mediaError: ref.mediaError,
        mimeType: ref.mimeType || metadata.mimeType,
        bytes: ref.bytes ?? metadata.bytes,
        naturalWidth: ref.width || metadata.naturalWidth,
        naturalHeight: ref.height || metadata.naturalHeight,
        durationMs: ref.durationMs ?? metadata.durationMs,
    };
}

function sameRef(a: CanvasMediaRef, b: CanvasMediaRef) {
    return (
        (a.content || "") === (b.content || "") &&
        (a.storageKey || "") === (b.storageKey || "") &&
        a.mediaStatus === b.mediaStatus &&
        (a.mediaError || "") === (b.mediaError || "")
    );
}

async function tryUploadImageSource(source: string | Blob, filename: string) {
    if (typeof source === "string" && isHttpUrl(source)) {
        return uploadRemoteImageToServer(source, filename);
    }
    try {
        if (typeof source === "string" && (isDataUrl(source) || isBlobUrl(source))) {
            return await uploadImage(source);
        }
        if (typeof source !== "string") {
            return await uploadImage(source);
        }
        return await uploadRemoteImageToServer(source, filename);
    } catch {
        // Cloud unavailable/unauthenticated: still persist locally so refresh keeps the image.
        if (typeof source === "string" && isHttpUrl(source)) throw new Error("远程图片上传失败");
        return uploadImage(source, { localOnly: true });
    }
}

async function tryUploadMediaSource(source: string | Blob, filename: string) {
    if (typeof source === "string" && isHttpUrl(source)) {
        return uploadRemoteMediaToServer(source, filename);
    }
    if (typeof source !== "string") {
        return uploadMediaBlob(source, filename);
    }
    if (isDataUrl(source) || isBlobUrl(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`读取媒体失败：${response.status}`);
        return uploadMediaBlob(await response.blob(), filename);
    }
    return uploadRemoteMediaToServer(source, filename);
}

/**
 * Repair one media ref for display + optional local-file cloud upload.
 * Priority: server: -> stable http(s)/api (display only) -> local IndexedDB upload -> broken.
 * Remote https (Grok etc.) is never auto-uploaded.
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

    // 1) server: pointer
    if (isServerKey(storageKey)) {
        const resolved =
            kind === "image"
                ? await resolveImageUrl(storageKey, isHttpUrl(originalContent) ? originalContent : serverContentUrl(storageKey))
                : await resolveMediaUrl(storageKey, isHttpUrl(originalContent) ? originalContent : serverContentUrl(storageKey));
        content = resolved || serverContentUrl(storageKey);
        if (content) {
            mediaStatus = "ok";
            mediaError = undefined;
        } else {
            content = "";
            mediaStatus = "broken";
            mediaError = "云端文件不可用";
        }
    }
    // 2) stable remote/API URL — display only, never auto-transfer Grok/https
    else if (isHttpUrl(content) && !isDataUrl(content)) {
        content = displayUrl(content);
        mediaStatus = "ok";
        mediaError = undefined;
    }
    // 3) data URL local payload
    else if (isDataUrl(content)) {
        // Always materialize data URLs into local/server storage so refresh does not drop multi-MB base64 nodes.
        try {
            const result = kind === "image" ? await tryUploadImageSource(content, filename) : await tryUploadMediaSource(content, filename);
            storageKey = result.storageKey;
            content = isServerKey(result.storageKey) ? serverContentUrl(result.storageKey) || result.url : result.url;
            uploaded = isServerKey(result.storageKey);
            if (uploaded) {
                mediaStatus = "ok";
                mediaError = undefined;
            } else if (storageKey) {
                // local image:/file: key — preview via object URL, keep portable key for this browser
                const resolved = kind === "image" ? await resolveImageUrl(storageKey, content) : await resolveMediaUrl(storageKey, content);
                content = resolved || content;
                mediaStatus = "local-only";
                mediaError = "未上云，换浏览器不可见";
            } else {
                mediaStatus = "local-only";
                mediaError = "未上云，换浏览器不可见";
            }
        } catch {
            mediaStatus = "local-only";
            mediaError = "未上云，换浏览器不可见";
        }
    }
    // 4) local IndexedDB keys
    else if (storageKey && ((kind === "image" && isLocalImageKey(storageKey)) || (kind === "media" && isLocalMediaKey(storageKey)))) {
        const localBlob = kind === "image" ? await getImageBlob(storageKey).catch(() => null) : await getMediaBlob(storageKey).catch(() => null);
        if (localBlob) {
            if (canUpload) {
                try {
                    const result = kind === "image" ? await tryUploadImageSource(localBlob, filename) : await tryUploadMediaSource(localBlob, filename);
                    storageKey = result.storageKey;
                    content = isServerKey(result.storageKey)
                        ? serverContentUrl(result.storageKey) || (isHttpUrl(result.url) ? displayUrl(result.url) : result.url)
                        : result.url;
                    uploaded = isServerKey(result.storageKey);
                    mediaStatus = uploaded || isHttpUrl(result.url) ? "ok" : "local-only";
                    mediaError = mediaStatus === "local-only" ? "未上云，换浏览器不可见" : undefined;
                    if (uploaded) {
                        if (kind === "image") await setImageBlob(storageKey, localBlob).catch(() => undefined);
                        else await setMediaBlob(storageKey, localBlob).catch(() => undefined);
                        // Prefer local blob preview immediately after upload.
                        if (kind === "image") {
                            const preview = await resolveImageUrl(storageKey, content);
                            if (preview) content = preview;
                        } else {
                            const preview = await resolveMediaUrl(storageKey, content);
                            if (preview) content = preview;
                        }
                    }
                } catch {
                    const resolved = kind === "image" ? await resolveImageUrl(storageKey, "") : await resolveMediaUrl(storageKey, "");
                    content = resolved || "";
                    mediaStatus = content ? "local-only" : "broken";
                    mediaError = content ? "未上云，换浏览器不可见" : "本地缓存不可用";
                }
            } else {
                const resolved = kind === "image" ? await resolveImageUrl(storageKey, "") : await resolveMediaUrl(storageKey, "");
                content = resolved || "";
                mediaStatus = content ? "local-only" : "broken";
                mediaError = content ? "未上云，换浏览器不可见" : "本地缓存不可用";
            }
        } else if (isHttpUrl(originalContent)) {
            content = displayUrl(originalContent);
            mediaStatus = "ok";
            mediaError = undefined;
        } else {
            content = "";
            mediaStatus = "broken";
            mediaError = "本地缓存丢失，请重新生成或手动上传";
        }
    }
    // 5) bare blob without recoverable key
    else if (isBlobUrl(content)) {
        if (!isForeignBlob(content) && canUpload) {
            try {
                const result = kind === "image" ? await tryUploadImageSource(content, filename) : await tryUploadMediaSource(content, filename);
                storageKey = result.storageKey;
                content = isServerKey(result.storageKey) ? serverContentUrl(result.storageKey) || result.url : result.url;
                uploaded = isServerKey(result.storageKey);
                mediaStatus = uploaded ? "ok" : "local-only";
                mediaError = uploaded ? undefined : "未上云，换浏览器不可见";
            } catch {
                content = "";
                mediaStatus = "broken";
                mediaError = "本地缓存丢失，请重新生成或手动上传";
            }
        } else if (!isForeignBlob(content)) {
            mediaStatus = "local-only";
            mediaError = "未上云，换浏览器不可见";
        } else {
            content = "";
            mediaStatus = "broken";
            mediaError = "媒体仅存于原浏览器本地，已失效";
        }
    } else if (!content && !storageKey) {
        mediaStatus = ref.mediaStatus;
        mediaError = ref.mediaError;
    }

    if (isForeignBlob(content)) {
        content = "";
        mediaStatus = "broken";
        mediaError = "媒体仅存于原浏览器本地，已失效";
    }

    const next: CanvasMediaRef = {
        ...ref,
        content,
        storageKey,
        mediaStatus,
        mediaError,
    };
    return {
        ref: next,
        changed: !sameRef(ref, next),
        uploaded,
    };
}

export async function repairCanvasNodeMedia(node: CanvasNodeData, options: { allowUpload?: boolean } = {}) {
    const metadata = node.metadata || {};
    const isImage = isCanvasImageNodeType(node.type);
    const isMedia = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    if (!isImage && !isMedia) return { node, changed: false, uploaded: false };

    if (!metadata.content && !metadata.storageKey && metadata.status !== "success") {
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

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }
    const runners = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => run());
    await Promise.all(runners);
    return results;
}

export async function repairCanvasNodesMedia(nodes: CanvasNodeData[], options: { allowUpload?: boolean } = {}) {
    let changed = false;
    let uploaded = 0;
    let broken = 0;
    const next = await mapPool(nodes, UPLOAD_CONCURRENCY, async (node) => {
        const result = await repairCanvasNodeMedia(node, options);
        if (result.changed) changed = true;
        if (result.uploaded) uploaded += 1;
        if (result.node.metadata?.mediaStatus === "broken") broken += 1;
        return result.node;
    });
    return { nodes: next, changed, uploaded, broken };
}

export async function repairCanvasSessionsMedia(sessions: CanvasAssistantSession[], options: { allowUpload?: boolean } = {}) {
    let changed = false;
    let uploaded = 0;
    let broken = 0;
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
                if (repaired.ref.mediaStatus === "broken") broken += 1;
                images.push({
                    ...image,
                    dataUrl: repaired.ref.content || image.dataUrl,
                    storageKey: repaired.ref.storageKey || image.storageKey,
                });
            }
            const references = [];
            for (const reference of message.references || []) {
                const kind = reference.type?.startsWith("video/") || reference.type?.startsWith("audio/") ? "media" : "image";
                const repaired = await repairCanvasMediaRef(
                    { content: reference.dataUrl || reference.url, storageKey: reference.storageKey },
                    kind,
                    { allowUpload: options.allowUpload, filename: "assistant-reference.bin" },
                );
                if (repaired.changed) changed = true;
                if (repaired.uploaded) uploaded += 1;
                if (repaired.ref.mediaStatus === "broken") broken += 1;
                references.push({
                    ...reference,
                    dataUrl: repaired.ref.content || reference.dataUrl,
                    url: isHttpUrl(repaired.ref.content) ? repaired.ref.content : reference.url,
                    storageKey: repaired.ref.storageKey || reference.storageKey,
                });
            }
            messages.push({ ...message, images, references });
        }
        nextSessions.push({ ...session, messages });
    }
    return { sessions: nextSessions, changed, uploaded, broken };
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
        broken: nodeResult.broken + sessionResult.broken,
    };
}

/** Manual one-click upload: local files and remote https (Grok etc.). */
export async function uploadCanvasNodeToCloud(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    if (isServerKey(metadata.storageKey)) {
        return {
            node: {
                ...node,
                metadata: {
                    ...metadata,
                    content: metadata.content || serverContentUrl(metadata.storageKey),
                    mediaStatus: "ok" as const,
                    mediaError: undefined,
                },
            },
            uploaded: false,
        };
    }
    const isImage = isCanvasImageNodeType(node.type);
    const isMedia = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    if (!isImage && !isMedia) throw new Error("该节点不支持上传云存储");

    const filename = `canvas-${node.type}-${node.id}.${isImage ? "png" : node.type === CanvasNodeType.Audio ? "mp3" : "mp4"}`;
    let source = "";
    if (isImage) {
        source = await resolveImageUrl(metadata.storageKey, metadata.content || "");
    } else {
        source = await resolveMediaUrl(metadata.storageKey, metadata.content || "");
    }
    if (!source) throw new Error("没有可上传的媒体内容");

    const result = isImage ? await tryUploadImageSource(source, filename) : await tryUploadMediaSource(source, filename);
    if (!isServerKey(result.storageKey)) throw new Error("云存储未启用或上传失败");

    const stable = serverContentUrl(result.storageKey) || result.url;
    let content = stable;
    // Keep snappy local preview when upload helper returns blob preview.
    if (result.url?.startsWith("blob:")) content = result.url;

    return {
        node: {
            ...node,
            metadata: {
                ...metadata,
                content,
                storageKey: result.storageKey,
                bytes: result.bytes || metadata.bytes,
                mimeType: result.mimeType || metadata.mimeType,
                naturalWidth: ("width" in result ? result.width : undefined) || metadata.naturalWidth,
                naturalHeight: ("height" in result ? result.height : undefined) || metadata.naturalHeight,
                durationMs: ("durationMs" in result ? result.durationMs : undefined) || metadata.durationMs,
                mediaStatus: "ok" as const,
                mediaError: undefined,
            },
        },
        uploaded: true,
    };
}
