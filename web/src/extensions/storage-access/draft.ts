import type { AdminStorageProvider } from "@/services/api/admin";
import type { StorageAccessConfig } from "./api";

export const storageAccessProviderKey = (provider: AdminStorageProvider) => provider.clientKey || provider.id;

export function remapStorageDrafts(saved: AdminStorageProvider[], submitted: AdminStorageProvider[]) {
    const remaining = [...submitted];
    // Match the normalized identity fields used by stableStorageProviderID in Go.
    const signature = (provider: AdminStorageProvider) => {
        const type = provider.type.trim().toLowerCase() || "s3";
        let endpoint = provider.endpoint.trim().replace(/\/+$/, "");
        if (endpoint && !endpoint.includes("://")) endpoint = `https://${endpoint}`;
        const path = type === "webdav" ? provider.pathPrefix.trim().replace(/^\/+|\/+$/g, "") || "canvas" : "";
        return JSON.stringify([provider.ownerUserId, type, provider.name.trim(), endpoint, provider.bucket.trim(), path]);
    };
    return saved.map((provider) => {
        const index = remaining.findIndex((draft) => draft.id ? draft.id === provider.id : signature(draft) === signature(provider));
        const draft = index < 0 ? undefined : remaining.splice(index, 1)[0];
        return { ...provider, clientKey: draft?.clientKey || provider.id };
    });
}

export function validateStorageAccess(provider: AdminStorageProvider, config: StorageAccessConfig) {
    const label = provider.name || provider.bucket || "未命名 OSS";
    if (config.defaultUpload && (!provider.enabled || provider.capacityExceeded)) throw new Error(`「${label}」作为默认上传位置必须启用且容量可用`);
    if (config.delivery !== "s3") {
        try {
            const url = new URL(config.cdnBaseUrl.trim());
            if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        } catch { throw new Error(`「${label}」需要填写有效的 HTTPS CDN 域名`); }
        if (!config.tokenKey.trim() && !config.hasTokenKey) throw new Error(`「${label}」需要填写 CDN 鉴权密钥`);
    }
    for (const origin of config.allowedOrigins) {
        const value = origin.trim();
        if (!value) continue;
        try {
            const url = new URL(value);
            if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value.includes("*")) throw new Error();
        } catch { throw new Error(`「${label}」的跨域来源无效：${value}`); }
    }
}
