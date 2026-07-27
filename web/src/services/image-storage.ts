"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { apiGet } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type UserStorageProvider = {
    enabled: boolean;
    name: string;
    type: "s3";
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    pathPrefix: string;
};

type UploadImageOptions = {
    localOnly?: boolean;
};

export type StorageConfig = {
    mode: string;
    allowUserProvider: boolean;
    allowUserGlobalProvider: boolean;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();
const serverUrls = new Map<string, string>();
export const USER_STORAGE_PROVIDER_KEY = "infinite-canvas:user_storage_provider";
let storageConfigPromise: Promise<StorageConfig> | null = null;

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
        const serverUpload = await maybeUploadImageToServer(blob);
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
    if (!token) throw new Error("服务端存储需要先登录");
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
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        if (fallback && !fallback.startsWith("blob:")) return fallback;
        const cached = objectUrls.get(storageKey);
        if (cached) return cached;
        const blob = await store.getItem<Blob>(storageKey).catch(() => null);
        if (blob) {
            const url = URL.createObjectURL(blob);
            objectUrls.set(storageKey, url);
            return url;
        }
        const cachedUrl = serverUrls.get(id);
        if (cachedUrl) return cachedUrl;
        const info = await apiGet<{ publicUrl?: string }>(`/api/files/${encodeURIComponent(id)}`).catch(() => null);
        if (!info) return fallback;
        const url = info?.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        serverUrls.set(id, url);
        return url;
    }
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function maybeUploadImageToServer(blob: Blob): Promise<UploadedImage | null> {
    const config = await loadStorageConfig().catch(() => null);
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider() : null;
    const canUseGlobalProvider = config ? canUseGlobalStorage(config) : false;
    const useServerStorage = canUseGlobalProvider || Boolean(userProvider);
    if (!config || !useServerStorage) return null;
    const token = useUserStore.getState().token;
    if (!token) {
        if (canUseGlobalProvider) throw new Error("服务端存储需要先登录");
        return null;
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
    const urls = [
        image.dataUrl && !image.dataUrl.startsWith("blob:") ? image.dataUrl : "",
        image.url && !image.url.startsWith("blob:") ? image.url : "",
        serverObjectId ? `/api/files/${encodeURIComponent(serverObjectId)}/content` : "",
        !serverObjectId ? await resolveImageUrl(image.storageKey, image.url || image.dataUrl || "") : "",
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

export async function deleteStoredImages(keys: Iterable<string>) {
    const { useAssetStore } = await import("@/stores/use-asset-store");
    const assetKeys = new Set(
        useAssetStore.getState().assets
            .map((a) => (a.kind !== "text" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k))
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (assetKeys.has(key)) return;
            if (key.startsWith("server:")) {
                await deleteServerImage(key);
                return;
            }
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("image:") || value.startsWith("server:")) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith("server:"))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

export function defaultUserStorageProvider(): UserStorageProvider {
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

export function loadUserStorageProvider() {
    if (typeof window === "undefined") return null;
    try {
        const parsed = JSON.parse(window.localStorage.getItem(USER_STORAGE_PROVIDER_KEY) || "null") as UserStorageProvider | null;
        if (!parsed?.enabled || !parsed.endpoint || !parsed.bucket || !parsed.accessKeyId || !parsed.secretAccessKey) return null;
        return { ...defaultUserStorageProvider(), ...parsed };
    } catch {
        return null;
    }
}

export function saveUserStorageProvider(provider: UserStorageProvider) {
    window.localStorage.setItem(USER_STORAGE_PROVIDER_KEY, JSON.stringify({ ...defaultUserStorageProvider(), ...provider }));
}

function toProviderPayload(provider: UserStorageProvider) {
    return {
        name: provider.name,
        type: provider.type || "s3",
        endpoint: provider.endpoint,
        region: provider.region || "auto",
        bucket: provider.bucket,
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
    if (!token) return;
    const provider = loadUserStorageProvider();
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(provider ? { provider: toProviderPayload(provider) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端图片失败");
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
