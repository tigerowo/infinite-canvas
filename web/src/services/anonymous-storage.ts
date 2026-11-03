type StorageObjectPayload = {
    url: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
};

type ApiPayload<T> = {
    code?: number;
    msg?: string;
    data?: T;
};

let anonymousSessionPromise: Promise<void> | null = null;

function ensureAnonymousStorageSession() {
    if (!anonymousSessionPromise) {
        anonymousSessionPromise = fetch("/api/anonymous/files/session", { method: "POST", credentials: "same-origin" }).then((response) => {
            if (!response.ok) throw new Error("匿名存储会话创建失败");
        }).catch((error) => {
            anonymousSessionPromise = null;
            throw error;
        });
    }
    return anonymousSessionPromise;
}

export async function uploadAnonymousStorageFile<T extends StorageObjectPayload>(blob: Blob, filename: string, provider: object): Promise<T> {
    await ensureAnonymousStorageSession();
    const formData = new FormData();
    formData.append("file", blob, filename);
    formData.append("provider", JSON.stringify(provider));
    const response = await fetch("/api/anonymous/files", { method: "POST", body: formData, credentials: "same-origin" });
    const payload = (await response.json().catch(() => null)) as ApiPayload<T> | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "匿名存储上传失败");
    return payload.data;
}

export async function uploadAnonymousTemporaryFile(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/anonymous/files/temporary", { method: "POST", body: formData });
    const payload = (await response.json().catch(() => null)) as ApiPayload<string> | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        throw new Error(payload?.msg || "匿名上传失败");
    }
    return payload.data;
}

export async function deleteAnonymousStorageFile(id: string, provider: object) {
    const response = await fetch(`/api/anonymous/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
        credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as ApiPayload<boolean> | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "匿名存储删除失败");
}
