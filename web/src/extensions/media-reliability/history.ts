import localforage from "localforage";
import { apiGet, apiPost } from "@/services/api/request";
import { assertMediaSession, mediaSession } from "./cache";

type Kind = "images" | "videos";
type RecordWithId = { id: string };
const pendingStore = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_pending_history" });
const chains = new Map<string, Promise<unknown>>();

function withHistory<T>(kind: Kind, token: string, run: (key: string, check: () => void) => Promise<T>) {
    const session = mediaSession();
    if (!session.userId || session.token !== token) return Promise.reject(new Error("账号尚未就绪，请稍后重试同步"));
    const key = `${session.userId}:${kind}`;
    const check = () => assertMediaSession(session);
    const task = (chains.get(key) || Promise.resolve()).catch(() => undefined).then(() => { check(); return run(key, check); });
    chains.set(key, task);
    void task.finally(() => { if (chains.get(key) === task) chains.delete(key); }).catch(() => undefined);
    return task;
}

async function flush(kind: Kind, token: string, key: string, check: () => void) {
    const pending = await pendingStore.getItem<Record<string, RecordWithId>>(key) || {};
    const logs = Object.values(pending);
    for (let offset = 0; offset < logs.length; offset += 100) {
        check();
        const batch = logs.slice(offset, offset + 100);
        await apiPost(`/api/v1/generation-logs/${kind}`, { logs: batch }, token);
        check();
        batch.forEach((log) => delete pending[log.id]);
        await pendingStore.setItem(key, pending);
    }
}

export function saveHistory<T>(kind: Kind, token: string, logs: T[]) {
    return withHistory(kind, token, async (key, check) => {
        const pending = await pendingStore.getItem<Record<string, T>>(key) || {};
        check();
        for (const log of logs) {
            const id = (log as RecordWithId).id;
            if (!id) throw new Error("生成记录缺少 ID");
            pending[id] = log;
        }
        await pendingStore.setItem(key, pending);
        await flush(kind, token, key, check);
        return logs;
    });
}

export function fetchHistory<T>(kind: Kind, token: string) {
    return withHistory(kind, token, async (key, check) => {
        // Recover local writes before a remote snapshot can replace local history.
        await flush(kind, token, key, check);
        check();
        const logs = await apiGet<T[]>(`/api/v1/generation-logs/${kind}`, undefined, token);
        check();
        return logs;
    });
}

export function deleteHistory(kind: Kind, token: string, ids: string[]) {
    return withHistory(kind, token, async (key, check) => {
        const result = await apiPost<{ deleted: boolean }>(`/api/v1/generation-logs/${kind}/delete`, { ids }, token);
        check();
        const pending = await pendingStore.getItem<Record<string, RecordWithId>>(key) || {};
        ids.forEach((id) => delete pending[id]);
        await pendingStore.setItem(key, pending);
        return result;
    });
}
