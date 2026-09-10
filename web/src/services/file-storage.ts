"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";

import { deleteAnonymousStorageFile, uploadAnonymousStorageFile } from "@/services/anonymous-storage";
import { canUseGlobalStorage, getProxyUrl, loadStorageConfig, clearStorageConfigCache, loadUserStorageProvider, toProviderPayload, type UserWebDAVStorageProvider } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { isSignedMediaURL, privateMediaURL } from "@/extensions/storage-access/signed-url";
import { assertMediaSession, clearMediaMapsOnSessionChange, mediaSession, scopedMediaStore } from "@/extensions/media-reliability/cache";
export { clearStorageConfigCache };

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = scopedMediaStore(localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" }));
const objectUrls = new Map<string, string>();
clearMediaMapsOnSessionChange(objectUrls);

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function uploadAssetMediaFile(file: File, prefix = "asset-media"): Promise<UploadedFile> {
    try {
        return await uploadMediaBlobToServer(file, file.name || `${prefix}-${nanoid()}`);
    } catch (error) {
        if (error instanceof Error && !error.message.includes("服务端对象存储未启用")) throw error;
        return uploadMediaFile(file, prefix);
    }
}

export async function downloadRemoteMedia(url: string) {
    const response = await fetch(getProxyUrl(url));
    if (!response.ok) throw new Error(`媒体下载失败：${response.status}`);
    const blob = await response.blob();
    if (blob.type.includes("json") || blob.type.startsWith("text/")) {
        const text = await blob.text().catch(() => "");
        let message = "";
        try {
            const payload = JSON.parse(text) as { msg?: string; message?: string };
            message = payload.msg || payload.message || "";
        } catch {
            message = text;
        }
        throw new Error(message || "媒体下载失败");
    }
    return blob;
}

export async function uploadRemoteMediaToServer(url: string, filename: string, globalOnly = false): Promise<UploadedFile> {
    const session = mediaSession();
    const blob = await downloadRemoteMedia(url);
    assertMediaSession(session);
    return uploadMediaBlobToServer(blob, filename, globalOnly);
}

async function uploadMediaBlobToServer(blob: Blob, filename: string, globalOnly = false): Promise<UploadedFile> {
    const session = mediaSession();
    const config = await loadStorageConfig().catch(() => null);
    const userProvider = !globalOnly && config?.allowUserProvider ? loadUserStorageProvider() : null;
    if (!config || (!canUseGlobalStorage(config) && !userProvider)) throw new Error("服务端对象存储未启用");
    const token = useUserStore.getState().token;
    assertMediaSession(session);
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVMediaDirect(blob, filename, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) throw new Error("请先登录后再同步媒体");
        const uploaded = await uploadAnonymousStorageFile<UploadedFile>(blob, filename, toProviderPayload(userProvider));
        return cacheAnonymousMedia(uploaded, blob);
    }
    const formData = new FormData();
    formData.append("file", blob, filename);
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedFile } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "媒体同步失败");
    assertMediaSession(session);
    return cacheAnonymousMedia(payload.data, blob);
}

async function uploadWebDAVMediaDirect(blob: Blob, filename: string, provider: UserWebDAVStorageProvider): Promise<UploadedFile | null> {
    const direct = await import("@/services/webdav-direct-storage");
    const uploaded = await direct.persistDirectWebDAV(provider, blob, filename);
    return uploaded ? cacheAnonymousMedia(uploaded, blob) : null;
}

async function cacheAnonymousMedia(uploaded: UploadedFile, blob: Blob) {
    const url = await setMediaBlob(uploaded.storageKey, blob);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : {};
    return { ...uploaded, url, bytes: uploaded.bytes || blob.size, mimeType: uploaded.mimeType || blob.type || "application/octet-stream", ...meta };
}

export async function uploadMediaBlob(blob: Blob, filename: string): Promise<UploadedFile> {
    return uploadMediaBlobToServer(blob, filename);
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    const session = mediaSession();
    const result = await resolveMediaUrlInSession(storageKey, fallback);
    assertMediaSession(session);
    return result;
}

async function resolveMediaUrlInSession(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const session = mediaSession();
    const blob = await store.getItem<Blob>(storageKey).catch(() => null);
    assertMediaSession(session);
    if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    }
    if (storageKey.startsWith("server:webdav:")) {
        const provider = loadUserStorageProvider();
        if (provider?.type !== "webdav") return fallback;
        const direct = await import("@/services/webdav-direct-storage");
        return direct.directWebDAVMediaUrl(provider, direct.directWebDAVObjectKey(storageKey));
    }
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        const signed = await privateMediaURL(id);
        if (signed) return signed;
        if (isSignedMediaURL(fallback)) fallback = "";
        if (fallback && !fallback.startsWith("blob:") && !fallback.includes("direct=1") && !fallback.startsWith("/webdav-media/")) return fallback;
        const { getStorageObjectInfo } = await import("@/services/api/storage");
        const info = await getStorageObjectInfo(id, useUserStore.getState().token).catch(() => null);
        if (!info) return fallback;
        const provider = loadUserStorageProvider();
        if (info.direct && provider?.type === "webdav") {
            const direct = await import("@/services/webdav-direct-storage");
            try {
                return await direct.directWebDAVMediaUrl(provider, info.objectKey);
            } catch (error) {
                if (!useUserStore.getState().token || !direct.isWebDAVDirectUnavailable(error)) throw error;
            }
        }
        const url = info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        return url;
    }
    return fallback;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const previous = objectUrls.get(storageKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function deleteServerMedia(storageKey: string) {
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const token = useUserStore.getState().token;
    const provider = loadUserStorageProvider();
    if (storageKey.startsWith("server:webdav:") && provider?.type !== "webdav") return;
    if (provider?.type === "webdav") {
        const direct = await import("@/services/webdav-direct-storage");
        if (await direct.deletePersistedDirectWebDAV(provider, storageKey)) {
            const url = objectUrls.get(storageKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(storageKey);
            await store.removeItem(storageKey);
            return;
        }
    }
    if (!token) {
        if (!provider) return;
        await deleteAnonymousStorageFile(id, toProviderPayload(provider));
        const url = objectUrls.get(storageKey);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await store.removeItem(storageKey);
        return;
    }
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(provider ? { provider: toProviderPayload(provider) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端视频失败");
    const url = objectUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(storageKey);
    await store.removeItem(storageKey);
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const { useAssetStore } = await import("@/stores/use-asset-store");
    const assetKeys = new Set(
        useAssetStore
            .getState()
            .assets.map((a) => (a.kind === "video" || a.kind === "audio" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k)),
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (assetKeys.has(key)) return;
            if (key.startsWith("server:")) {
                await deleteServerMedia(key);
                return;
            }
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map(async (key) => {
        const url = objectUrls.get(key);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(key);
        await store.removeItem(key);
    }));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => {
            const dimensions = { width: video.videoWidth || 1280, height: video.videoHeight || 720 };
            clearTimeout(timeout);
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute("src");
            video.load();
            resolve(dimensions);
        };
        const timeout = setTimeout(done, 15000);
        video.preload = "metadata";
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}
