import type localforage from "localforage";
import { useUserStore } from "@/stores/use-user-store";

export function mediaSession() {
    const { token, user } = useUserStore.getState();
    return { token, userId: user?.id };
}

export function assertMediaSession(session: ReturnType<typeof mediaSession>) {
    const current = mediaSession();
    if (session.token !== current.token || session.userId !== current.userId) throw new Error("账号已切换，请重新操作");
}

export function privateCacheKey(key: string) {
    if (!key.startsWith("server:")) return key;
    const { token, userId } = mediaSession();
    if (token && !userId) return null;
    return `ext:media-reliability:${token ? `user:${userId}` : "guest"}:${key}`;
}

// Legacy server blobs have no owner. Keep them on disk, but never adopt them into an account.
export function scopedMediaStore(storage: Pick<typeof localforage, "getItem" | "setItem" | "removeItem" | "iterate">) {
    return {
        async getItem<T>(key: string) {
            const session = mediaSession(), scoped = privateCacheKey(key);
            const value = scoped ? await storage.getItem<T>(scoped) : null;
            assertMediaSession(session);
            return value;
        },
        async setItem<T>(key: string, value: T) {
            const session = mediaSession(), scoped = privateCacheKey(key);
            if (scoped) await storage.setItem(scoped, value);
            assertMediaSession(session);
            return value;
        },
        async removeItem(key: string) {
            const scoped = privateCacheKey(key);
            if (scoped) await storage.removeItem(scoped);
        },
        async iterate(callback: (value: unknown, key: string) => void) {
            const session = mediaSession();
            const prefix = privateCacheKey("server:")?.slice(0, -"server:".length);
            await storage.iterate((value, key) => {
                assertMediaSession(session);
                if (prefix && key.startsWith(prefix)) callback(value, key.slice(prefix.length));
                else if (!key.startsWith("server:") && !key.startsWith("ext:media-reliability:")) callback(value, key);
            });
        },
    };
}

export function clearMediaMapsOnSessionChange(objectUrls: Map<string, string>, ...maps: Map<string, string>[]) {
    useUserStore.subscribe((state, previous) => {
        if (state.token === previous.token && state.user?.id === previous.user?.id) return;
        for (const url of objectUrls.values()) URL.revokeObjectURL(url);
        objectUrls.clear();
        maps.forEach((map) => map.clear());
    });
}

export function retryableRequest<T>(load: () => Promise<T>) {
    let pending: Promise<T> | null = null;
    return {
        clear() { pending = null; },
        get() {
            if (pending) return pending;
            const task = load().catch((error) => {
                if (pending === task) pending = null;
                throw error;
            });
            pending = task;
            return task;
        },
    };
}
