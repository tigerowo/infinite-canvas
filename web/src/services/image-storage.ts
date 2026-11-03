"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { readImageMeta } from "@/lib/image-utils";
import { deleteAnonymousStorageFile, uploadAnonymousStorageFile } from "@/services/anonymous-storage";
import { apiGet } from "@/services/api/request";
import { comfyOutputStorageKey } from "@/services/api/workflow-generation";
import { useUserStore } from "@/stores/use-user-store";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type UserStorageProviderBase = {
    enabled: boolean;
    name: string;
    endpoint: string;
};

export type UserS3StorageProvider = UserStorageProviderBase & {
    type: "s3";
    region: string;
    bucket: string;
    bucketInHost: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    pathPrefix: string;
};

export type UserWebDAVStorageProvider = UserStorageProviderBase & {
    type: "webdav";
    pathPrefix: string;
    username: string;
    password: string;
};

export type UserStorageProvider = UserS3StorageProvider | UserWebDAVStorageProvider;

type UploadImageOptions = {
    localOnly?: boolean;
    token?: string;
};

export type StorageConfig = {
    mode: string;
    allowUserProvider: boolean;
    allowUserGlobalProvider: boolean;
    autoSyncAllAssets: boolean;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const previewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" });
const objectUrls = new Map<string, string>();
const previewUrls = new Map<string, { source: string; url: string }>();
const previewSources = new Map<string, string>();
const previewRequests = new Map<string, { source: string; promise: Promise<string | undefined> }>();
const previewDeletes = new Map<string, Promise<void>>();
const previewEpochs = new Map<string, number>();
const previewListeners = new Set<() => void>();
const serverUrls = new Map<string, string>();
const previewQueue: Array<() => void> = [];
const IMAGE_PREVIEW_VERSION = 1;
const IMAGE_PREVIEW_CONCURRENCY = 2;
let previewRevision = 0;
let previewActive = 0;
export const USER_STORAGE_PROVIDER_KEY = "infinite-canvas:user_storage_provider";
export const USER_WEBDAV_STORAGE_PROVIDER_KEY = "infinite-canvas:user_webdav_storage_provider";
let storageConfigPromise: Promise<StorageConfig> | null = null;
export const STORAGE_SYNC_FAILED_EVENT = "infinite-canvas:storage-sync-failed";
const autoSyncRequests = new Map<string | Blob, Promise<{ storageKey: string } | null>>();
let autoSyncOwner = "";

type StoredImagePreview = {
    version: number;
    source: string;
    blob?: Blob;
};

export function previewUrlFor(key: string, source?: string) {
    const cached = previewUrls.get(key);
    return cached && (!source || cached.source === source) ? cached.url : undefined;
}

export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export async function ensureImagePreview(key: string, url?: string, storageKey?: string, source = storageKey || url || "", cachedOnly = false): Promise<string | undefined> {
    if (!key || !source) return undefined;
    if (isLocalImageSource(url) || isComfyImageSource(storageKey) || isComfyImageSource(url)) {
        await deleteImagePreviews([key]);
        return undefined;
    }

    if (previewSources.get(key) !== source) {
        previewEpochs.set(key, (previewEpochs.get(key) || 0) + 1);
        previewRequests.delete(key);
    }
    previewSources.set(key, source);
    const cached = previewUrls.get(key);
    if (cached?.source === source) return cached.url;
    if (cached) removeCachedPreview(key);

    const running = previewRequests.get(key);
    if (running?.source === source) return running.promise;

    const epoch = previewEpochs.get(key) || 0;
    const promise = loadImagePreview(key, source, epoch, url, storageKey, cachedOnly).catch(() => undefined);
    previewRequests.set(key, { source, promise });
    try {
        return await promise;
    } finally {
        if (previewRequests.get(key)?.promise === promise) previewRequests.delete(key);
    }
}

export async function deleteImagePreviews(keys: Iterable<string>) {
    const uniqueKeys = Array.from(new Set(keys));
    let changed = false;
    uniqueKeys.forEach((key) => {
        previewEpochs.set(key, (previewEpochs.get(key) || 0) + 1);
        previewRequests.delete(key);
        previewSources.delete(key);
        changed = removeCachedPreview(key, false) || changed;
    });
    await Promise.all(
        uniqueKeys.map((key) => {
            const removal = (previewDeletes.get(key) || Promise.resolve())
                .then(() => previewStore.removeItem(key))
                .catch(() => undefined);
            previewDeletes.set(key, removal);
            return removal.finally(() => {
                if (previewDeletes.get(key) === removal) previewDeletes.delete(key);
            });
        }),
    );
    if (changed) notifyPreviewChange();
}

export async function deleteUnusedImagePreviews(prefix: string, usedKeys: ReadonlySet<string>) {
    const keys = await previewStore.keys().catch(() => []);
    await deleteImagePreviews(keys.filter((key) => key.startsWith(prefix) && !usedKeys.has(key)));
}

async function loadImagePreview(key: string, source: string, epoch: number, url?: string, storageKey?: string, cachedOnly = false) {
    const isCurrent = () => previewSources.get(key) === source && previewEpochs.get(key) === epoch;
    await previewDeletes.get(key);
    if (!isCurrent()) return undefined;

    const stored = await previewStore.getItem<StoredImagePreview>(key).catch(() => null);
    if (!isCurrent()) return undefined;

    if (stored?.version === IMAGE_PREVIEW_VERSION && stored.source === source) {
        return stored.blob ? cacheImagePreview(key, source, stored.blob) : undefined;
    }
    if (stored) await previewStore.removeItem(key).catch(() => undefined);
    if (cachedOnly) return undefined;

    return queueImagePreview(async () => {
        if (!isCurrent()) return undefined;

        const resolvedUrl = url || (storageKey ? await resolveImageUrl(storageKey, "") : "");
        if (!resolvedUrl || isLocalImageSource(resolvedUrl) || isComfyImageSource(resolvedUrl) || !isCurrent()) return undefined;

        const response = await fetch(getProxyUrl(resolvedUrl));
        if (!response.ok || !isCurrent()) return undefined;
        const blob = await response.blob();
        const preview = await createImageThumbnail(blob);
        if (!isCurrent()) return undefined;

        await previewStore.setItem<StoredImagePreview>(key, {
            version: IMAGE_PREVIEW_VERSION,
            source,
            blob: preview,
        });
        if (!isCurrent()) return undefined;
        return preview ? cacheImagePreview(key, source, preview) : undefined;
    });
}

function queueImagePreview<T>(task: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
        const run = () => {
            previewActive += 1;
            void task()
                .then(resolve, reject)
                .finally(() => {
                    previewActive -= 1;
                    previewQueue.shift()?.();
                });
        };
        if (previewActive < IMAGE_PREVIEW_CONCURRENCY) run();
        else previewQueue.push(run);
    });
}

function isLocalImageSource(source?: string) {
    const value = source?.trim();
    if (!value) return false;
    const lower = value.toLowerCase();
    return lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("image:") || (value.length > 256 && /^[a-z\d+/=\s]+$/i.test(value));
}

function isComfyImageSource(source?: string) {
    if (!source) return false;
    if (source.startsWith("comfy:")) return true;
    try {
        const parsed = new URL(source, "http://127.0.0.1:8189");
        if (parsed.protocol === "https:") parsed.protocol = "http:";
        return Boolean(comfyOutputStorageKey(parsed.href));
    } catch {
        return false;
    }
}

function cacheImagePreview(key: string, source: string, blob: Blob) {
    if (previewSources.get(key) !== source) return undefined;
    const cached = previewUrls.get(key);
    if (cached?.source === source) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(blob);
    previewUrls.set(key, { source, url });
    notifyPreviewChange();
    return url;
}

function removeCachedPreview(key: string, notify = true) {
    const cached = previewUrls.get(key);
    if (!cached) return false;
    URL.revokeObjectURL(cached.url);
    previewUrls.delete(key);
    if (notify) notifyPreviewChange();
    return true;
}

function notifyPreviewChange() {
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
}

export async function autoSyncToCloud<T extends { storageKey: string }>(source: string | Blob, upload: () => Promise<T | null>): Promise<T | null> {
    const config = await loadStorageConfig().catch(() => null);
    if (!config?.autoSyncAllAssets || (!canUseGlobalStorage(config) && !(config.allowUserProvider && loadUserStorageProvider()))) return null;
    const owner = useUserStore.getState().token;
    if (autoSyncOwner !== owner) {
        autoSyncRequests.clear();
        autoSyncOwner = owner;
    }
    const existing = autoSyncRequests.get(source);
    if (existing) return existing as Promise<T | null>;
    const request = upload().catch((error) => {
        reportStorageSyncFailure(error);
        return null;
    });
    autoSyncRequests.set(source, request);
    const result = await request;
    if ((source instanceof Blob || !result) && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
    return result;
}

export function clearAutoSyncCache(storageKey: string) {
    for (const [source, request] of autoSyncRequests) {
        void request.then((result) => {
            if (result?.storageKey === storageKey && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
        });
    }
}

export async function autoSyncImage(url: string, resultId: string, storageKey?: string) {
    if (!url || storageKey) return null;
    return autoSyncToCloud(`image:${resultId}`, async () => {
        try {
            return await uploadRemoteImageToServer(url, "image");
        } catch (error) {
            if (!url.startsWith("data:") && !url.startsWith("blob:")) throw error;
            reportStorageSyncFailure(error);
            return uploadImage(url, { localOnly: true });
        }
    });
}

function reportStorageSyncFailure(error: unknown) {
    window.dispatchEvent(new CustomEvent(STORAGE_SYNC_FAILED_EVENT, { detail: error instanceof Error ? error.message : "" }));
}

export function canUseGlobalStorage(config: StorageConfig) {
    const user = useUserStore.getState().user;
    return config.mode === "server_sqlite_s3" && Boolean(user && user.role !== "guest" && (user.role === "admin" || config.allowUserGlobalProvider));
}

function isLocalNetworkHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host === "host.docker.internal" ||
        host === "::1"
    ) {
        return true;
    }
    if (
        host.includes(":") &&
        (host.startsWith("fc") ||
            host.startsWith("fd") ||
            /^fe[89ab]/.test(host))
    ) {
        return true;
    }
    const parts = host.split(".").map(Number);
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return false;
    }
    const [a, b] = parts;
    return (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
    );
}

export function getProxyUrl(url: string): string {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return url;
    }
    try {
        const parsed = new URL(url);
        if (
            isLocalNetworkHost(parsed.hostname) ||
            (typeof window !== "undefined" &&
                parsed.host === window.location.host)
        ) {
            return url;
        }
    } catch {
        return url;
    }
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

export async function uploadImage(input: string | Blob, options: UploadImageOptions = {}): Promise<UploadedImage> {
    const url = typeof input === "string" ? getProxyUrl(input) : input;
    let blob: Blob;
    if (typeof url === "string") {
        const response = await fetch(url);
        if (!response.ok) {
            const payload = await response.json().catch(() => null) as { msg?: string } | null;
            throw new Error(payload?.msg || `代理图片拉取失败：${response.status}`);
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const payload = await response.json().catch(() => null) as { msg?: string } | null;
            throw new Error(payload?.msg || "代理图片下载失败");
        }
        blob = await response.blob();
    } else {
        blob = url;
    }
    if (!options.localOnly) {
        const serverUpload = await maybeUploadImageToServer(blob, options.token);
        if (serverUpload) return serverUpload;
    }
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const urlObj = URL.createObjectURL(blob);
    objectUrls.set(storageKey, urlObj);
    const meta = await readImageMeta(urlObj);
    return { url: urlObj, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function uploadRemoteImageToServer(url: string, filename: string): Promise<UploadedImage> {
    const response = await fetch(getProxyUrl(url));
    if (!response.ok) {
        const payload = await response.json().catch(() => null) as { msg?: string } | null;
        throw new Error(payload?.msg || "代理图片拉取失败：" + response.status);
    }
    const blob = await response.blob();
    const config = await loadStorageConfig();
    const userProvider = config.allowUserProvider ? loadUserStorageProvider() : null;
    if (!canUseGlobalStorage(config) && !userProvider) throw new Error("服务端对象存储未启用");
    const token = useUserStore.getState().token;
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVImageDirect(blob, filename || `image-${nanoid()}.${imageExtension(blob.type)}`, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) throw new Error("服务端存储需要先登录");
        const uploaded = await uploadAnonymousStorageFile<UploadedImage>(blob, filename || "image-" + nanoid() + "." + imageExtension(blob.type), toProviderPayload(userProvider));
        return cacheAnonymousImage(uploaded, blob);
    }
    const formData = new FormData();
    formData.append("file", blob, filename || "image-" + nanoid() + "." + imageExtension(blob.type));
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const uploadResponse = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: "Bearer " + token }, body: formData });
    const payload = (await uploadResponse.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!uploadResponse.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "服务端图片上传失败");
    const meta = await readImageMeta(payload.data.url);
    if (payload.data.storageKey?.startsWith("server:")) serverUrls.set(payload.data.storageKey.slice("server:".length), payload.data.url);
    return { ...payload.data, width: payload.data.width || meta.width, height: payload.data.height || meta.height, mimeType: payload.data.mimeType || blob.type || "image/png", bytes: payload.data.bytes || blob.size };
}

export function clearStorageConfigCache() {
    storageConfigPromise = null;
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (storageKey.startsWith("server:webdav:")) {
        const localUrl = await resolveLocalImageUrl(storageKey).catch(() => "");
        if (localUrl) return localUrl;
        const provider = loadUserStorageProvider();
        if (provider?.type !== "webdav") return fallback;
        const direct = await import("@/services/webdav-direct-storage");
        const blob = await direct.readDirectWebDAV(provider, direct.directWebDAVObjectKey(storageKey));
        return setImageBlob(storageKey, blob);
    }
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        if (fallback && !fallback.startsWith("blob:") && !fallback.includes("direct=1")) return fallback;
        const localUrl = await resolveLocalImageUrl(storageKey).catch(() => "");
        if (localUrl) return localUrl;
        const cachedUrl = serverUrls.get(id);
        if (cachedUrl) return cachedUrl;
        const { getStorageObjectInfo } = await import("@/services/api/storage");
        const info = await getStorageObjectInfo(id).catch(() => null);
        if (!info) return fallback;
        const provider = loadUserStorageProvider();
        if (info.direct && provider?.type === "webdav") {
            const direct = await import("@/services/webdav-direct-storage");
            try {
                const blob = await direct.readDirectWebDAV(provider, info.objectKey, info.mimeType);
                return setImageBlob(storageKey, blob);
            } catch (error) {
                if (!useUserStore.getState().token || !direct.isWebDAVDirectUnavailable(error)) throw error;
            }
        }
        const url = info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        serverUrls.set(id, url);
        return url;
    }
    return await resolveLocalImageUrl(storageKey) || fallback;
}

async function resolveLocalImageUrl(storageKey: string) {
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function maybeUploadImageToServer(blob: Blob, tokenOverride?: string): Promise<UploadedImage | null> {
    const config = await loadStorageConfig().catch(() => null);
    if (tokenOverride !== undefined && useUserStore.getState().token !== tokenOverride) {
        throw new Error("登录状态已变化");
    }
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider() : null;
    const canUseGlobalProvider = config ? canUseGlobalStorage(config) : false;
    const useServerStorage = canUseGlobalProvider || Boolean(userProvider);
    if (!config || !useServerStorage) return null;
    const token = tokenOverride === undefined ? useUserStore.getState().token : tokenOverride;
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVImageDirect(blob, `image-${nanoid()}.${imageExtension(blob.type)}`, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) {
            if (canUseGlobalProvider) throw new Error("服务端存储需要先登录");
            return null;
        }
        try {
            const uploaded = await uploadAnonymousStorageFile<UploadedImage>(blob, `image-${nanoid()}.${imageExtension(blob.type)}`, toProviderPayload(userProvider));
            return cacheAnonymousImage(uploaded, blob);
        } catch {
            return null;
        }
    }
    const formData = new FormData();
    formData.append("file", blob, `image-${nanoid()}.${imageExtension(blob.type)}`);
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        if (!canUseGlobalProvider) return null;
        throw new Error(payload?.msg || "服务端图片上传失败");
    }
    const meta = await readImageMeta(payload.data.url);
    if (payload.data.storageKey?.startsWith("server:")) serverUrls.set(payload.data.storageKey.slice("server:".length), payload.data.url);
    return { ...payload.data, width: payload.data.width || meta.width, height: payload.data.height || meta.height, mimeType: payload.data.mimeType || blob.type || "image/png", bytes: payload.data.bytes || blob.size };
}

async function uploadWebDAVImageDirect(blob: Blob, filename: string, provider: UserWebDAVStorageProvider): Promise<UploadedImage | null> {
    const direct = await import("@/services/webdav-direct-storage");
    const uploaded = await direct.persistDirectWebDAV(provider, blob, filename);
    return uploaded ? cacheAnonymousImage({ ...uploaded, width: 0, height: 0 }, blob) : null;
}

async function cacheAnonymousImage(uploaded: UploadedImage, blob: Blob) {
    await store.setItem(uploaded.storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(uploaded.storageKey, url);
    if (uploaded.storageKey.startsWith("server:") && uploaded.url && !uploaded.url.includes("direct=1")) serverUrls.set(uploaded.storageKey.slice("server:".length), uploaded.url);
    const meta = await readImageMeta(url);
    return { ...uploaded, url, width: uploaded.width || meta.width, height: uploaded.height || meta.height, mimeType: uploaded.mimeType || blob.type || meta.mimeType, bytes: uploaded.bytes || blob.size };
}

export async function loadStorageConfig() {
    storageConfigPromise ||= apiGet<StorageConfig>("/api/storage/config");
    return storageConfigPromise;
}

function imageExtension(mimeType: string) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const serverObjectId = image.storageKey?.startsWith("server:") ? image.storageKey.slice("server:".length) : "";
    const directGuestObject = image.storageKey?.startsWith("server:webdav:");
    const hasPersistedUrl = [image.dataUrl, image.url].some((url) => Boolean(url && !url.startsWith("blob:")));
    const localUrl = !useUserStore.getState().token && serverObjectId && image.storageKey && !hasPersistedUrl
        ? await resolveLocalImageUrl(image.storageKey).catch(() => "")
        : "";
    const resolvedUrl = image.storageKey
        ? await resolveImageUrl(image.storageKey, image.url || image.dataUrl || "")
        : "";
    const urls = [
        image.dataUrl && !image.dataUrl.startsWith("blob:") ? image.dataUrl : "",
        image.url && !image.url.startsWith("blob:") ? image.url : "",
        localUrl,
        resolvedUrl,
        serverObjectId && !directGuestObject ? `/api/files/${encodeURIComponent(serverObjectId)}/content` : "",
    ].filter((url, index, list): url is string => Boolean(url) && list.indexOf(url) === index);
    if (!urls.length) return "";
    let lastError = "";
    for (const url of urls) {
        if (url.startsWith("data:")) return url;
        try {
            const proxyUrl = getProxyUrl(url);
            const response = await fetch(proxyUrl);
            if (!response.ok) {
                lastError = `读取参考图失败：${response.status}`;
                continue;
            }
            return blobToDataUrl(await response.blob());
        } catch (error) {
            lastError = error instanceof Error ? error.message : "读取参考图失败";
        }
    }
    throw new Error(lastError || "读取参考图失败");
}

export async function deleteStoredImages(keys: Iterable<string>, ownerToken?: string) {
    const { useAssetStore } = await import("@/stores/use-asset-store");
    const assetKeys = new Set(
        useAssetStore.getState().assets
            .map((a) => (a.kind !== "text" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k))
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (assetKeys.has(key) || (ownerToken !== undefined && useUserStore.getState().token !== ownerToken)) return;
            if (key.startsWith("server:")) {
                await deleteServerImage(key);
                return;
            }
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
            clearAutoSyncCache(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown, storageKeys: ReadonlyMap<string, string> = new Map(), ownerToken?: string) {
    const usedKeys = collectImageStorageKeys(usedData, new Set(), storageKeys);
    const unused = Array.from(new Set(storageKeys.values())).filter((key) => key.startsWith("server:") && !usedKeys.has(key));
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused, ownerToken);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>(), knownUrls?: ReadonlyMap<string, string>, capturedUrls?: Map<string, string>) {
    if (typeof value === "string") {
        if (value.startsWith("image:") || value.startsWith("server:")) keys.add(value);
        const referencedKey = knownUrls?.get(value);
        if (referencedKey) keys.add(referencedKey);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith("server:"))) {
        keys.add(value.storageKey);
        if (capturedUrls) {
            for (const field of ["content", "url", "dataUrl"]) {
                const url = (value as Record<string, unknown>)[field];
                if (typeof url === "string" && url) capturedUrls.set(url, value.storageKey);
            }
        }
    }
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys, knownUrls, capturedUrls)) : collectImageStorageKeys(item, keys, knownUrls, capturedUrls)));
    return keys;
}

export function defaultUserStorageProvider(): UserS3StorageProvider {
    return {
        enabled: false,
        name: "我的 R2",
        type: "s3",
        endpoint: "",
        region: "auto",
        bucket: "",
        bucketInHost: false,
        accessKeyId: "",
        secretAccessKey: "",
        publicBaseUrl: "",
        pathPrefix: "canvas",
    };
}

export function defaultUserWebDAVStorageProvider(): UserWebDAVStorageProvider {
    return {
        enabled: false,
        name: "我的 WebDAV",
        type: "webdav",
        endpoint: "",
        pathPrefix: "canvas",
        username: "",
        password: "",
    };
}

export function loadUserS3StorageProvider() {
    if (typeof window === "undefined") return null;
    try {
        const parsed = JSON.parse(window.localStorage.getItem(USER_STORAGE_PROVIDER_KEY) || "null") as UserS3StorageProvider | null;
        return parsed ? { ...defaultUserStorageProvider(), ...parsed, type: "s3" as const } : null;
    } catch {
        return null;
    }
}

export function loadUserWebDAVStorageProvider() {
    if (typeof window === "undefined") return null;
    try {
        const parsed = JSON.parse(window.localStorage.getItem(USER_WEBDAV_STORAGE_PROVIDER_KEY) || "null") as UserWebDAVStorageProvider | null;
        return parsed ? { ...defaultUserWebDAVStorageProvider(), ...parsed, type: "webdav" as const } : null;
    } catch {
        return null;
    }
}

export function loadUserStorageProvider(): UserStorageProvider | null {
    const s3 = loadUserS3StorageProvider();
    const webdav = loadUserWebDAVStorageProvider();
    if (s3?.enabled && webdav?.enabled) return null;
    if (s3?.enabled && validS3Provider(s3)) return s3;
    if (webdav?.enabled && validWebDAVProvider(webdav)) return webdav;
    return null;
}

export function saveUserStorageProvider(provider: UserS3StorageProvider) {
    window.localStorage.setItem(USER_STORAGE_PROVIDER_KEY, JSON.stringify({ ...defaultUserStorageProvider(), ...provider, type: "s3" }));
}

export function saveUserWebDAVStorageProvider(provider: UserWebDAVStorageProvider) {
    window.localStorage.setItem(USER_WEBDAV_STORAGE_PROVIDER_KEY, JSON.stringify({ ...defaultUserWebDAVStorageProvider(), ...provider, type: "webdav" }));
}

function validS3Provider(provider: UserS3StorageProvider) {
    return Boolean(provider.endpoint && provider.bucket && provider.accessKeyId && provider.secretAccessKey);
}

function validWebDAVProvider(provider: UserWebDAVStorageProvider) {
    return Boolean(provider.endpoint && provider.username && provider.password);
}

export function toProviderPayload(provider: UserStorageProvider) {
    if (provider.type === "webdav") {
        return {
            enabled: provider.enabled,
            name: provider.name,
            type: "webdav" as const,
            endpoint: provider.endpoint,
            pathPrefix: provider.pathPrefix,
            username: provider.username,
            password: provider.password,
        };
    }
    return {
        enabled: provider.enabled,
        name: provider.name,
        type: "s3" as const,
        endpoint: provider.endpoint,
        region: provider.region || "auto",
        bucket: provider.bucket,
        bucketInHost: provider.bucketInHost,
        accessKeyId: provider.accessKeyId,
        secretAccessKey: provider.secretAccessKey,
        publicBaseUrl: provider.publicBaseUrl,
        pathPrefix: provider.pathPrefix,
    };
}

async function deleteServerImage(storageKey: string) {
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const token = useUserStore.getState().token;
    serverUrls.delete(id);
    const provider = loadUserStorageProvider();
    if (storageKey.startsWith("server:webdav:") && provider?.type !== "webdav") return;
    if (provider?.type === "webdav") {
        const direct = await import("@/services/webdav-direct-storage");
        if (await direct.deletePersistedDirectWebDAV(provider, storageKey)) {
            clearAutoSyncCache(storageKey);
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
        clearAutoSyncCache(storageKey);
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
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端图片失败");
    clearAutoSyncCache(storageKey);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
