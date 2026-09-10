import { getProxyUrl, resolveImageUrl, imageToDataUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import { loadModelPolicy } from "@/extensions/model-capabilities/policy";
import { assertMediaSession, mediaSession } from "@/extensions/media-reliability/cache";
import { rememberMediaIdentity, resolveMediaIdentity, withMediaLock } from "@/extensions/media-reliability/identity";

type Reference = { storageKey?: string; url?: string; dataUrl?: string; name?: string; type?: string };
type PublicReference = { url: string; expiresAt: string; mimeType: string; storageKey?: string };
const pending = new Map<string, Promise<PublicReference>>();
const uploaded = new Map<string, string>();
const knownURLs = new Map<string, PublicReference>();
const signedObjects = new Map<string, PublicReference>();
useUserStore.subscribe((state, previous) => {
    if (state.token === previous.token && state.user?.id === previous.user?.id) return;
    pending.clear(); uploaded.clear(); knownURLs.clear(); signedObjects.clear();
});

export function isPublicHTTPS(value: string) {
    try {
        const u = new URL(value);
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (u.protocol !== "https:" || u.username || u.password || !host.includes(".")) return false;
        if (host === "localhost" || /\.(localhost|local|internal)$/.test(host) || host.includes(":")) return false;
        const parts = host.split(".").map(Number);
        if (parts.length === 4 && parts.every(Number.isInteger)) {
            const [a, b] = parts;
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
        }
        return true;
    } catch { return false; }
}

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
    if (map.size >= 128) map.delete(map.keys().next().value!);
    map.set(key, value);
}

async function requestData<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "S3 素材处理失败");
    return payload.data;
}

export async function publicReferenceURL(reference: Reference, kind: "image" | "media" = "image"): Promise<string> {
    const session = mediaSession();
    if (!session.token || !session.userId) throw new Error("请先登录，素材需要上传 S3 后才能用于模型请求");
    const policy = await loadModelPolicy().catch(() => ({ imageTransfer: "url" as const, overrides: {} }));
    assertMediaSession(session);
    if (kind === "image" && policy.imageTransfer === "base64") {
        const result = await imageToDataUrl(reference);
        assertMediaSession(session);
        return result;
    }
    const source = reference.url || reference.dataUrl || "";
    const known = knownURLs.get(source);
    const resolvedKey = await resolveMediaIdentity(reference);
    assertMediaSession(session);
    if (known && (!resolvedKey || known.storageKey === resolvedKey) && Date.parse(known.expiresAt) > Date.now() + 300_000) return source;
    const digest = reference.storageKey || Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))).map((n) => n.toString(16).padStart(2, "0")).join("");
    assertMediaSession(session);
    const key = `${session.userId}:${session.token}:${resolvedKey || digest}`;
    let task = pending.get(key);
    if (!task) {
        task = withMediaLock(reference.storageKey || source, async () => {
            assertMediaSession(session);
            const headers = { Authorization: `Bearer ${session.token}` };
            let storageKey = uploaded.get(key) || await resolveMediaIdentity(reference) || known?.storageKey || "";
            assertMediaSession(session);
            if (!storageKey.startsWith("server:") && /^https?:\/\//.test(source)) {
                const resolved = await requestData<{ storageKey?: string }>("/api/extensions/media-archive/resolve", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ url: source }) });
                assertMediaSession(session);
                storageKey = resolved.storageKey || storageKey;
            }
            if (!storageKey.startsWith("server:") || storageKey.startsWith("server:webdav:")) {
                const local = kind === "image"
                    ? await resolveImageUrl(reference.storageKey, source)
                    : await resolveMediaUrl(reference.storageKey, source);
                if (!local) throw new Error("找不到参考素材，请重新上传");
                const response = await fetch(getProxyUrl(local));
                if (!response.ok) throw new Error(`参考素材读取失败：${response.status}`);
                const blob = await response.blob();
                assertMediaSession(session);
                if (!blob.size || (!blob.type.startsWith("image/") && !blob.type.startsWith("video/") && !blob.type.startsWith("audio/"))) throw new Error("参考素材必须是有效的图片、视频或音频");
                const form = new FormData();
                form.append("file", blob, reference.name || "reference");
                const result = await requestData<{ storageKey: string }>("/api/v1/files", { method: "POST", headers, body: form });
                assertMediaSession(session);
                storageKey = result.storageKey;
                remember(uploaded, key, storageKey);
            }
            await rememberMediaIdentity(reference.storageKey || source, storageKey);
            await rememberMediaIdentity(source, storageKey);
            assertMediaSession(session);
            const cached = signedObjects.get(storageKey);
            if (cached && Date.parse(cached.expiresAt) > Date.now() + 300_000) return cached;
            const result = await requestData<PublicReference>(`/api/extensions/public-media/files/${encodeURIComponent(storageKey.slice(7))}/url`, { headers });
            assertMediaSession(session);
            if (!isPublicHTTPS(result.url)) throw new Error("S3 返回了非公网 HTTPS 地址，请检查 Endpoint");
            await rememberMediaIdentity(result.url, storageKey);
            assertMediaSession(session);
            remember(knownURLs, result.url, { ...result, storageKey });
            remember(signedObjects, storageKey, { ...result, storageKey });
            return { ...result, storageKey };
        });
        pending.set(key, task);
        void task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
    }
    const result = await task;
    assertMediaSession(session);
    return result.url;
}

export const publicImageURL = (reference: Reference) => publicReferenceURL(reference, "image");
export const publicMediaURL = (reference: Reference) => publicReferenceURL(reference, "media");

export function geminiPublicPart(url: string) {
    if (url.startsWith("data:")) {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
        if (!match) throw new Error("Base64 参考图片格式无效");
        return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    if (!isPublicHTTPS(url)) throw new Error("Gemini 参考素材需要公网 HTTPS 地址");
    return { fileData: { fileUri: url, mimeType: knownURLs.get(url)?.mimeType || "image/png" } };
}
