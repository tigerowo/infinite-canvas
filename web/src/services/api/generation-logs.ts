import { deleteHistory, fetchHistory, saveHistory } from "@/extensions/media-reliability/history";

export async function fetchVideoGenerationLogs<T>(token: string) {
    return fetchHistory<T>("videos", token);
}

export async function saveVideoGenerationLogs<T>(token: string, logs: T[]) {
    return saveHistory("videos", token, logs);
}

export async function deleteVideoGenerationLog(token: string, id: string) {
    return deleteHistory("videos", token, [id]);
}

export async function deleteVideoGenerationLogs(token: string, ids: string[]) {
    return deleteHistory("videos", token, ids);
}

export async function fetchImageGenerationLogs<T>(token: string) {
    return fetchHistory<T>("images", token);
}

export async function saveImageGenerationLogs<T>(token: string, logs: T[]) {
    return saveHistory("images", token, logs);
}

export async function deleteImageGenerationLogs(token: string, ids: string[]) {
    return deleteHistory("images", token, ids);
}


