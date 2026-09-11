"use client";

import localforage from "localforage";
import { lifecycleEpoch, lifecycleHeaders, inspectLifecycleEpoch } from "@/extensions/media-lifecycle/session";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { uploadAnonymousStorageFile } from "@/services/anonymous-storage";
import { apiGet } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";
import { isSignedMediaURL, privateMediaURL } from "@/extensions/storage-access/signed-url";
import { assertMediaSession, clearMediaMapsOnSessionChange, mediaSession, retryableRequest, scopedMediaStore } from "@/extensions/media-reliability/cache";
import { canReleaseMediaCache, importRemoteMedia, rememberMediaIdentity, rememberSyncResult, resolveMediaIdentity, savedSyncResult, withMediaLock } from "@/extensions/media-reliability/identity";

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
};

export type StorageConfig = {
    mode: string;
    allowUserProvider: boolean;
    allowUserGlobalProvider: boolean;
    autoSyncAllAssets: boolean;
};

const store = scopedMediaStore(localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" }));
const objectUrls = new Map<string, string>();
const serverUrls = new Map<string, string>();
const imageReads = new Map<string, Promise<string>>();
clearMediaMapsOnSessionChange(objectUrls, serverUrls);
useUserStore.subscribe((state, previous) => { if (state.token !== previous.token || state.user?.id !== previous.user?.id) imageReads.clear(); });
export const USER_STORAGE_PROVIDER_KEY = "infinite-canvas:user_storage_provider";
export const USER_WEBDAV_STORAGE_PROVIDER_KEY = "infinite-canvas:user_webdav_storage_provider";
const storageConfigRequest = retryableRequest(() => apiGet<StorageConfig>("/api/storage/config"));
export const STORAGE_SYNC_FAILED_EVENT = "infinite-canvas:storage-sync-failed";
const autoSyncRequests = new Map<string | Blob, Promise<{ storageKey: string } | null>>();
let autoSyncOwner = "";

export async function autoSyncToCloud<T extends { storageKey: string }>(source: string | Blob, upload: () => Promise<T | null>): Promise<T | null> {
    const session = mediaSession();
    const config = await loadStorageConfig().catch(() => null);
    assertMediaSession(session);
    if (!config?.autoSyncAllAssets || (!canUseGlobalStorage(config) && !(config.allowUserProvider && loadUserStorageProvider()))) return null;
    const owner = JSON.stringify(session);
    if (autoSyncOwner !== owner) {
        autoSyncRequests.clear();
        autoSyncOwner = owner;
    }
    const existing = autoSyncRequests.get(source);
    if (existing) {
        const result = await existing;
        assertMediaSession(session);
        return result as T | null;
    }
    const perform = async () => {
        if (typeof source === "string") {
            const saved = await savedSyncResult<T>(source);
            if (saved) {
                const url = source.startsWith("image:") ? await resolveImageUrl(saved.storageKey) : await (await import("@/services/file-storage")).resolveMediaUrl(saved.storageKey);
                assertMediaSession(session);
                if (url) return { ...saved, url };
            }
        }
        const result = await upload();
        assertMediaSession(session);
        if (typeof source === "string" && result?.storageKey.startsWith("server:")) await rememberSyncResult(source, result);
        return result;
    };
    const request = (typeof source === "string" ? withMediaLock(`sync:${source}`, perform) : perform()).catch((error) => {
        assertMediaSession(session);
        reportStorageSyncFailure(error);
        return null;
    });
    autoSyncRequests.set(source, request);
    let result: T | null = null;
    try {
        result = await request;
        assertMediaSession(session);
        return result;
    } finally {
        if ((source instanceof Blob || !result) && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
    }
}

export function clearAutoSyncCache(storageKey: string) {
    for (const [source, request] of autoSyncRequests) {
        void request.then((result) => {
            if (result?.storageKey === storageKey && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
        }).catch(() => {});
    }
}

export async function autoSyncImage(url: string, resultId: string, storageKey?: string) {
    if (!url || storageKey) return null;
    const session = mediaSession();
    return autoSyncToCloud(`image:${resultId}`, async () => {
        try {
            return await uploadRemoteImageToServer(url, "image", true);
        } catch (error) {
            assertMediaSession(session);
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
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal" || host === "::1") {
        return true;
    }
    if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host))) {
        return true;
    }
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function getProxyUrl(url: string): string {
    if (isSignedMediaURL(url)) return url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return url;
    }
    try {
        const parsed = new URL(url);
        if (isLocalNetworkHost(parsed.hostname) || (typeof window !== "undefined" && parsed.host === window.location.host)) {
            return url;
        }
    } catch {
        return url;
    }
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

export async function uploadImage(input: string | Blob, options: UploadImageOptions = {}): Promise<UploadedImage> {
    const session = mediaSession();
    const url = typeof input === "string" ? getProxyUrl(input) : input;
    let blob: Blob;
    if (typeof url === "string") {
        const response = await fetch(url);
        if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { msg?: string } | null;
            throw new Error(payload?.msg || `代理图片拉取失败：${response.status}`);
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const payload = (await response.json().catch(() => null)) as { msg?: string } | null;
            throw new Error(payload?.msg || "代理图片下载失败");
        }
        blob = await response.blob();
    } else {
        blob = url;
    }
    assertMediaSession(session);
    if (!options.localOnly) {
        const serverUpload = await maybeUploadImageToServer(blob);
        assertMediaSession(session);
        if (serverUpload) return serverUpload;
    }
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const urlObj = URL.createObjectURL(blob);
    objectUrls.set(storageKey, urlObj);
    const meta = await readImageMeta(urlObj);
    return { url: urlObj, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function uploadRemoteImageToServer(url: string, filename: string, globalOnly = false): Promise<UploadedImage> {
    const session = mediaSession();
    if (globalOnly && session.token && /^https?:\/\//.test(url)) {
        const saved = await importRemoteMedia(url, filename);
        return { ...saved, url: await resolveImageUrl(saved.storageKey), width: 0, height: 0 };
    }
    const response = await fetch(getProxyUrl(url));
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(payload?.msg || "代理图片拉取失败：" + response.status);
    }
    const blob = await response.blob();
    const config = await loadStorageConfig();
    const userProvider = !globalOnly && config.allowUserProvider ? loadUserStorageProvider() : null;
    if (!canUseGlobalStorage(config) && !userProvider) throw new Error("服务端对象存储未启用");
    const token = useUserStore.getState().token;
    assertMediaSession(session);
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
    await lifecycleEpoch(token);
    const uploadResponse = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: "Bearer " + token, ...lifecycleHeaders(token) }, body: formData });
    inspectLifecycleEpoch(token, uploadResponse.headers.get("X-Media-Epoch"));
    const payload = (await uploadResponse.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!uploadResponse.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "服务端图片上传失败");
    assertMediaSession(session);
    await rememberMediaIdentity(url, payload.data.storageKey);
    return cacheAnonymousImage(payload.data, blob);
}

export function clearStorageConfigCache() {
    storageConfigRequest.clear();
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    const session = mediaSession();
    const result = await resolveImageUrlInSession(storageKey, fallback);
    assertMediaSession(session);
    return result;
}

async function resolveImageUrlInSession(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (storageKey.startsWith("server:webdav:")) {
        const localUrl = await resolveLocalImageUrl(storageKey).catch(() => "");
        if (localUrl) return localUrl;
        const provider = loadUserStorageProvider();
        if (provider?.type !== "webdav") return fallback;
        const direct = await import("@/services/webdav-direct-storage");
        const session = mediaSession();
        const blob = await direct.readDirectWebDAV(provider, direct.directWebDAVObjectKey(storageKey));
        assertMediaSession(session);
        return setImageBlob(storageKey, blob);
    }
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        const localUrl = await resolveLocalImageUrl(storageKey).catch(() => "");
        if (localUrl) return localUrl;
        const signed = await privateMediaURL(id);
        if (signed) return signed;
        if (isSignedMediaURL(fallback)) fallback = "";
        if (fallback && !fallback.startsWith("blob:") && !fallback.includes("direct=1")) return fallback;
        const cachedUrl = serverUrls.get(id);
        if (cachedUrl) return cachedUrl;
        const { getStorageObjectInfo } = await import("@/services/api/storage");
        const info = await getStorageObjectInfo(id, useUserStore.getState().token).catch(() => null);
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
    return (await resolveLocalImageUrl(storageKey)) || fallback;
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

async function maybeUploadImageToServer(blob: Blob): Promise<UploadedImage | null> {
    const session = mediaSession();
    const config = await loadStorageConfig().catch(() => null);
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider() : null;
    const canUseGlobalProvider = config ? canUseGlobalStorage(config) : false;
    const useServerStorage = canUseGlobalProvider || Boolean(userProvider);
    if (!config || !useServerStorage) return null;
    const token = useUserStore.getState().token;
    assertMediaSession(session);
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
    await lifecycleEpoch(token);
    const response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}`, ...lifecycleHeaders(token) }, body: formData });
    inspectLifecycleEpoch(token, response.headers.get("X-Media-Epoch"));
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        if (!canUseGlobalProvider) return null;
        throw new Error(payload?.msg || "服务端图片上传失败");
    }
    assertMediaSession(session);
    return cacheAnonymousImage(payload.data, blob);
}

async function uploadWebDAVImageDirect(blob: Blob, filename: string, provider: UserWebDAVStorageProvider): Promise<UploadedImage | null> {
    const direct = await import("@/services/webdav-direct-storage");
    const uploaded = await direct.persistDirectWebDAV(provider, blob, filename);
    return uploaded ? cacheAnonymousImage({ ...uploaded, width: 0, height: 0 }, blob) : null;
}

async function cacheAnonymousImage(uploaded: UploadedImage, blob: Blob) {
    const url = await setImageBlob(uploaded.storageKey, blob);
    if (uploaded.storageKey.startsWith("server:") && uploaded.url && !uploaded.url.includes("direct=1")) serverUrls.set(uploaded.storageKey.slice("server:".length), uploaded.url);
    const meta = await readImageMeta(url);
    return { ...uploaded, url, width: uploaded.width || meta.width, height: uploaded.height || meta.height, mimeType: uploaded.mimeType || blob.type || meta.mimeType, bytes: uploaded.bytes || blob.size };
}

export async function loadStorageConfig() {
    return storageConfigRequest.get();
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
    const previous = objectUrls.get(storageKey);
    // OSS object identities are immutable. Repeated uploads can deduplicate to
    // this object while existing history cards still display its cached URL.
    if (previous && storageKey.startsWith("server:") && !storageKey.startsWith("server:webdav:")) return previous;
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const session = mediaSession();
    const storageKey = await resolveMediaIdentity(image);
    assertMediaSession(session);
    const key = JSON.stringify([session, storageKey || image.dataUrl || image.url]);
    let task = imageReads.get(key);
    if (!task) {
        task = readImageDataUrl({ ...image, storageKey, localKey: image.storageKey });
        imageReads.set(key, task);
        void task.finally(() => { if (imageReads.get(key) === task) imageReads.delete(key); }).catch(() => {});
    }
    const result = await task;
    assertMediaSession(session);
    return result;
}

async function readImageDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string; localKey?: string }) {
    const session = mediaSession();
    for (const key of new Set([image.storageKey, image.localKey].filter((key): key is string => Boolean(key)))) {
        const cached = await getImageBlob(key);
        assertMediaSession(session);
        if (cached) return blobToDataUrl(cached);
    }
    const serverObjectId = image.storageKey?.startsWith("server:") ? image.storageKey.slice("server:".length) : "";
    const directGuestObject = image.storageKey?.startsWith("server:webdav:");
    const hasPersistedUrl = [image.dataUrl, image.url].some((url) => Boolean(url && !url.startsWith("blob:")));
    const localUrl = !useUserStore.getState().token && serverObjectId && image.storageKey && !hasPersistedUrl ? await resolveLocalImageUrl(image.storageKey).catch(() => "") : "";
    const resolvedUrl = image.storageKey ? await resolveImageUrl(image.storageKey, image.url || image.dataUrl || "") : "";
    const urls = [
        resolvedUrl,
        image.dataUrl && !image.dataUrl.startsWith("blob:") ? image.dataUrl : "",
        image.url && !image.url.startsWith("blob:") ? image.url : "",
        localUrl,
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
            const blob = await response.blob();
            assertMediaSession(session);
            if (image.storageKey) await setImageBlob(image.storageKey, blob);
            return blobToDataUrl(blob);
        } catch (error) {
            assertMediaSession(session);
            lastError = error instanceof Error ? error.message : "读取参考图失败";
        }
    }
    throw new Error(lastError || "读取参考图失败");
}

export async function deleteStoredImages(keys: Iterable<string>, ownerToken?: string) {
    const session = mediaSession();
    const { useAssetStore } = await import("@/stores/use-asset-store");
    assertMediaSession(session);
    const assetKeys = new Set(
        useAssetStore
            .getState()
            .assets.map((a) => (a.kind !== "text" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k)),
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            assertMediaSession(session);
            if (!canReleaseMediaCache(key) || assetKeys.has(key) || (ownerToken !== undefined && useUserStore.getState().token !== ownerToken)) return;
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
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
        accessKeyId: provider.accessKeyId,
        secretAccessKey: provider.secretAccessKey,
        publicBaseUrl: provider.publicBaseUrl,
        pathPrefix: provider.pathPrefix,
    };
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
