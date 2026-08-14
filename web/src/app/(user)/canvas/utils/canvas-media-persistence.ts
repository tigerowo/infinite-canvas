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
            mediaError = "媒体仅存于原浏览器本地，已失效";
        }
    } else if (isBlobUrl(content)) {
        // Foreign/local blob without readable storageKey cannot be recovered on another origin.
        content = "";
        mediaStatus = "broken";
        mediaError = "媒体仅存于原浏览器本地，已失效";
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
                mediaError = "媒体仅存于原浏览器本地，已失效";
            }
        } catch {
            content = "";
            mediaStatus = "broken";
            mediaError = "媒体仅存于原浏览器本地，已失效";
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

export async function repairCanvasNodeMedia(node: CanvasNodeData, options: { allowUpload?: boolean } = {}) {
    const metadata = node.metadata || {};
    const isImage = isCanvasImageNodeType(node.type);
    const isMedia = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    if (!isImage && !isMedia) return { node, changed: false, uploaded: false };

    // Skip empty idle placeholders.
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

export async function repairCanvasNodesMedia(nodes: CanvasNodeData[], options: { allowUpload?: boolean } = {}) {
    let changed = false;
    let uploaded = 0;
    let broken = 0;
    const next = [];
    for (const node of nodes) {
        const result = await repairCanvasNodeMedia(node, options);
        next.push(result.node);
        if (result.changed) changed = true;
        if (result.uploaded) uploaded += 1;
        if (result.node.metadata?.mediaStatus === "broken") broken += 1;
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
