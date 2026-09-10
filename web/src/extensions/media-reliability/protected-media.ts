import localforage from "localforage";
import { assertMediaSession, mediaSession } from "./cache";
import { identityKey, rememberMediaIdentity, withMediaLock } from "./identity";

type StoredMedia = { storageKey: string; url: string };
const results = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_protected_media" });
const pending = new Map<string, Promise<StoredMedia>>();

// Keep local-only results too: protected content needs credentials to download again.
export async function reuseProtectedMedia(source: string, resolve: (key: string) => Promise<string>, create: () => Promise<StoredMedia>): Promise<StoredMedia> {
    const session = mediaSession();
    if (!session.userId || !session.token) return create();
    const key = `${session.userId}:${await identityKey(source)}`;
    assertMediaSession(session);
    const pendingKey = `${session.token}:${key}`;
    const existing = pending.get(pendingKey);
    if (existing) return existing;
    const task = withMediaLock(`protected:${source}`, async () => {
        const saved = await results.getItem<string>(key).catch(() => null);
        assertMediaSession(session);
        if (saved) {
            const url = await resolve(saved);
            assertMediaSession(session);
            if (url) return { storageKey: saved, url };
        }
        const media = await create();
        assertMediaSession(session);
        await results.setItem(key, media.storageKey).catch(() => undefined);
        assertMediaSession(session);
        await rememberMediaIdentity(source, media.storageKey);
        return media;
    });
    pending.set(pendingKey, task);
    try { return await task; }
    finally { if (pending.get(pendingKey) === task) pending.delete(pendingKey); }
}
