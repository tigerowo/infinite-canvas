import localforage from "localforage";
import { assertMediaSession, mediaSession } from "./cache";

const identities = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_media_identities" });
export type MediaReference = { storageKey?: string; url?: string; dataUrl?: string };
type MediaResult = { storageKey: string; url?: string; bytes?: number; mimeType?: string; width?: number; height?: number; durationMs?: number };

export async function savedSyncResult<T extends MediaResult>(source: string): Promise<T | null> {
    const session = mediaSession();
    if (!session.userId || !session.token) return null;
    const key = `${session.userId}:sync:${await identityKey(source)}`;
    assertMediaSession(session);
    const result = await identities.getItem<T>(key).catch(() => null);
    assertMediaSession(session);
    return result;
}

export async function rememberSyncResult(source: string, result: MediaResult) {
    const session = mediaSession();
    if (!session.userId || !session.token || !result.storageKey.startsWith("server:")) return;
    const key = `${session.userId}:sync:${await identityKey(source)}`;
    assertMediaSession(session);
    const { storageKey, bytes, mimeType, width, height, durationMs } = result;
    await identities.setItem(key, { storageKey, bytes, mimeType, width, height, durationMs }).catch(() => undefined);
    assertMediaSession(session);
}

export async function identityKey(source: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function savedMediaIdentity(source: string) {
    const session = mediaSession();
    if (!source || !session.userId || !session.token) return "";
    const hash = await identityKey(source);
    assertMediaSession(session);
    const key = await identities.getItem<string>(`${session.userId}:${hash}`).catch(() => null);
    assertMediaSession(session);
    return key || "";
}

export async function rememberMediaIdentity(source: string, storageKey: string) {
    const session = mediaSession();
    if (!source || !session.userId || !session.token || !storageKey.startsWith("server:")) return;
    const hash = await identityKey(source);
    assertMediaSession(session);
    await identities.setItem(`${session.userId}:${hash}`, storageKey).catch(() => undefined);
    assertMediaSession(session);
}

export async function resolveMediaIdentity(reference: MediaReference) {
    if (reference.storageKey?.startsWith("server:") && !reference.storageKey.startsWith("server:webdav:")) return reference.storageKey;
    for (const source of [reference.storageKey, reference.url, reference.dataUrl]) {
        if (!source) continue;
        const saved = await savedMediaIdentity(source);
        if (saved) return saved;
    }
    return reference.storageKey || "";
}

// Cross-tab coordination is an optimization; the server also uses immutable upload identities.
export async function withMediaLock<T>(source: string, run: () => Promise<T>): Promise<T> {
    const session = mediaSession();
    const key = `${session.userId}:${await identityKey(source)}`;
    assertMediaSession(session);
    const checked = () => { assertMediaSession(session); return run(); };
    return typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request(`ext:media:${key}`, checked) : checked();
}

export async function importRemoteMedia(url: string, filename: string) {
    const session = mediaSession();
    const response = await fetch("/api/extensions/media-archive/import", {
        method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, filename }),
    });
    const payload = await response.json().catch(() => null);
    assertMediaSession(session);
    if (!response.ok || payload?.code !== 0 || !payload.data?.storageKey) throw new Error(payload?.msg || "服务端保存媒体失败");
    await rememberMediaIdentity(url, payload.data.storageKey);
    return payload.data as { url: string; storageKey: string; bytes: number; mimeType: string };
}

// Removing a node/history entry must never destroy shared cloud files or the only offline copy.
export function canReleaseMediaCache(storageKey: string) {
    return storageKey.startsWith("server:") && !storageKey.startsWith("server:webdav:");
}
