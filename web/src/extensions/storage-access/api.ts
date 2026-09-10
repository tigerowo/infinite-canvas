import { apiGet } from "@/services/api/request";

export type StorageAccessConfig = {
    allowedOrigins: string[];
    delivery: "s3" | "edgeone-b" | "esa-a";
    defaultUpload?: boolean;
    cdnBaseUrl: string;
    tokenKey: string;
    hasTokenKey: boolean;
};
export type StorageAccessProvider = { id: string; name: string; bucket: string; enabled: boolean; config: StorageAccessConfig };
export type StorageAccessConfigInput = StorageAccessConfig & { providerId: string };

export function loadStorageAccess(token: string) {
    return apiGet<StorageAccessProvider[]>("/api/extensions/storage-access", undefined, token);
}

export async function saveStorageAccess(token: string, id: string, config: StorageAccessConfig): Promise<StorageAccessConfig> {
    const response = await fetch("/api/extensions/storage-access/" + encodeURIComponent(id), {
        method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(config),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0 || !payload.data) throw new Error(payload.msg || "保存存储访问设置失败");
    return payload.data;
}

export async function saveStorageAccessBatch(token: string, providers: StorageAccessConfigInput[]): Promise<StorageAccessProvider[]> {
    const response = await fetch("/api/extensions/storage-access", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0 || !payload.data) throw new Error(payload.msg || "保存存储访问设置失败");
    return payload.data;
}
