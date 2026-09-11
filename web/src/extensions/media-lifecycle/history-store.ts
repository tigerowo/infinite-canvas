import localforage from "localforage";
import { assertMediaSession, mediaSession } from "../media-reliability/cache";
import { knownLifecycleEpoch, lifecycleEpoch } from "./session";

type Scope = { prefix: string; check: () => void };
type Storage = Pick<LocalForage, "getItem" | "setItem" | "removeItem" | "keys" | "iterate">;

async function historyScope(): Promise<Scope> {
    const session = mediaSession();
    if (session.token && !session.userId) throw new Error("账号尚未就绪，请稍后载入历史");
    const epoch = session.token ? await lifecycleEpoch(session.token) : 1;
    const check = () => {
        assertMediaSession(session);
        if (session.token && knownLifecycleEpoch(session.token) !== epoch) throw new Error("云端保留范围已变化，请刷新后载入历史；本机副本已保留");
    };
    check();
    return { prefix: `ext:media-lifecycle:history:${session.token ? `user:${encodeURIComponent(session.userId!)}` : "guest"}:${epoch}:`, check };
}

// Legacy unscoped records stay on disk as recovery copies. Their owner is
// unknown, so neither login nor a clear may silently adopt them into an account.
export function scopedHistoryStore(storage: Storage, scope = historyScope) {
    return {
        async getItem<T>(key: string): Promise<T | null> {
            const current = await scope();
            const value = await storage.getItem<T>(current.prefix + key);
            current.check();
            return value;
        },
        async setItem<T>(key: string, value: T): Promise<T> {
            const current = await scope();
            await storage.setItem(current.prefix + key, value);
            current.check();
            return value;
        },
        async removeItem(key: string): Promise<void> {
            const current = await scope();
            await storage.removeItem(current.prefix + key);
            current.check();
        },
        async keys(): Promise<string[]> {
            const current = await scope();
            const keys = await storage.keys();
            current.check();
            return keys.filter((key) => key.startsWith(current.prefix)).map((key) => key.slice(current.prefix.length));
        },
        async clear(): Promise<void> {
            const current = await scope();
            const keys = await storage.keys();
            current.check();
            await Promise.all(keys.filter((key) => key.startsWith(current.prefix)).map((key) => storage.removeItem(key)));
            current.check();
        },
        async iterate<T, U>(visit: (value: T, key: string, iteration: number) => U): Promise<U> {
            const current = await scope();
            let index = 0;
            const result = await storage.iterate<T, U>((value, key) => {
                current.check();
                if (key.startsWith(current.prefix)) return visit(value, key.slice(current.prefix.length), ++index);
                return undefined as U;
            });
            current.check();
            return result;
        },
    };
}

export function createHistoryStore(storeName: "image_generation_logs" | "video_generation_logs" | "image_generation_categories") {
    return scopedHistoryStore(localforage.createInstance({ name: "infinite-canvas", storeName }));
}
