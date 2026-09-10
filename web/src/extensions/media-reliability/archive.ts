import localforage from "localforage";
import { uploadRemoteImageToServer, resolveImageUrl } from "@/services/image-storage";
import { uploadRemoteMediaToServer, resolveMediaUrl } from "@/services/file-storage";
import { assertMediaSession, mediaSession } from "./cache";

type ArchiveKind = "image" | "video";
type ArchiveRecord = { status: "pending" | "saved" | "failed"; storageKey?: string; error?: string };
export type ArchiveResult = { url: string; storageKey: string; archiveError?: string };
const records = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_media_archive" });
const jobs = new Map<string, Promise<ArchiveResult>>();
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(run: () => Promise<T>) {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await run(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
}

// The manifest stores object identities, not expiring URLs or credentials.
export async function archiveGeneratedMedia(kind: ArchiveKind, id: string, url: string, storageKey = "", retry = false): Promise<ArchiveResult> {
    if (storageKey.startsWith("server:")) return { url, storageKey };
    const session = mediaSession();
    if (!session.token || !session.userId) return { url, storageKey };
    const key = `${session.userId}:${kind}:${id}`;
    const existing = jobs.get(key);
    if (existing) return existing;
    const run = limited(async () => {
        assertMediaSession(session);
        const prior = await records.getItem<ArchiveRecord>(key);
        assertMediaSession(session);
        if (prior?.status === "saved" && prior.storageKey) {
            const resolved = kind === "image" ? await resolveImageUrl(prior.storageKey) : await resolveMediaUrl(prior.storageKey);
            assertMediaSession(session);
            return { url: resolved || url, storageKey: prior.storageKey };
        }
        if (prior?.status === "failed" && !retry) return { url, storageKey, archiveError: prior.error };
        await records.setItem(key, { status: "pending" } satisfies ArchiveRecord);
        try {
            assertMediaSession(session);
            const source = storageKey ? await (kind === "image" ? resolveImageUrl(storageKey, url) : resolveMediaUrl(storageKey, url)) : url;
            const saved = kind === "image"
                ? await uploadRemoteImageToServer(source, `generated-${id}.png`, true)
                : await uploadRemoteMediaToServer(source, `generated-${id}.mp4`, true);
            assertMediaSession(session);
            await records.setItem(key, { status: "saved", storageKey: saved.storageKey } satisfies ArchiveRecord);
            return saved;
        } catch (cause) {
            assertMediaSession(session);
            const error = cause instanceof Error ? cause.message : "保存失败";
            await records.setItem(key, { status: "failed", error } satisfies ArchiveRecord);
            return { url, storageKey, archiveError: error };
        }
    });
    jobs.set(key, run);
    try { return await run; }
    finally { if (jobs.get(key) === run) jobs.delete(key); }
}
