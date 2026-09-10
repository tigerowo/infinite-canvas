import { apiDelete, apiGet, apiPost } from "@/services/api/request";
import type { UserWebDAVStorageProvider } from "@/services/image-storage";

export type RegisteredStorageObject = {
    url: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
};

export type StorageObjectInfo = {
    id: string;
    objectKey: string;
    publicUrl: string;
    mimeType: string;
    bytes: number;
    direct: boolean;
};

export type StorageObjectSignedURL = {
    url: string;
    expiresAt: string;
    mimeType: string;
    bytes: number;
};

export function getStorageObjectInfo(id: string, token?: string) {
    return apiGet<StorageObjectInfo>(`/api/files/${encodeURIComponent(id)}`, undefined, token);
}

export function getStorageObjectSignedURL(id: string, token: string) {
    return apiGet<StorageObjectSignedURL>(`/api/v1/files/${encodeURIComponent(id)}/signed-url`, undefined, token);
}

export function registerDirectStorageObject(token: string, payload: { provider: UserWebDAVStorageProvider; objectKey: string; mimeType: string; bytes: number }) {
    return apiPost<RegisteredStorageObject>("/api/v1/files/direct", payload, token);
}

export function deleteDirectStorageObjectRecord(token: string, id: string) {
    return apiDelete<boolean>(`/api/v1/files/${encodeURIComponent(id)}/record`, token);
}
