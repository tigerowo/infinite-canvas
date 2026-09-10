import { getStorageObjectSignedURL } from "@/services/api/storage";
import { useUserStore } from "@/stores/use-user-store";

const cache = new Map<string, { url: string; expiresAt: number }>();
const pending = new Map<string, Promise<string>>();
export function invalidatePrivateMediaURL(id: string) { cache.delete(id); }
let generation = 0;

useUserStore.subscribe((state, previous) => {
    if (state.token !== previous.token || state.user?.id !== previous.user?.id) {
        generation++; cache.clear(); pending.clear();
    }
});

// One in-memory cache for images, videos and audio; never persists credentials or URLs.
export function privateMediaURL(id: string): Promise<string> {
    const token = useUserStore.getState().token;
    if (!token) return Promise.resolve("");
    const saved = cache.get(id);
    if (saved && saved.expiresAt > Date.now() + 30_000) return Promise.resolve(saved.url);
    if (pending.has(id)) return pending.get(id)!;
    const started = generation;
    const task = getStorageObjectSignedURL(id, token).then((signed) => {
        const expiresAt = Date.parse(signed.expiresAt);
        if (started !== generation || !signed.url || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) return "";
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(id, { url: signed.url, expiresAt });
        return signed.url;
    }).catch(() => "").finally(() => { if (pending.get(id) === task) pending.delete(id); });
    pending.set(id, task);
    return task;
}

export function isSignedMediaURL(value: string): boolean {
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && (
            (url.searchParams.has("X-Amz-Signature") && url.searchParams.has("X-Amz-Credential")) ||
            /^\d+-[^-]+-[^-]+-[a-f0-9]{32}$/i.test(url.searchParams.get("auth_key") || "") ||
            /^\/\d{12}\/[a-f0-9]{32}\//i.test(url.pathname)
        );
    } catch { return false; }
}
