import { imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveMediaIdentity } from "./identity";
import { assertMediaSession, mediaSession } from "./cache";
import { mapMedia } from "./snapshot";

type ImageReference = { storageKey?: string; dataUrl: string };
type FileReference = { storageKey?: string; url: string };

export async function restoreHistoryImages<T extends ImageReference>(references: T[], cache = false): Promise<T[]> {
    const session = mediaSession();
    const result = await mapMedia(references, async (reference) => {
        const storageKey = await resolveMediaIdentity(reference);
        const resolved = { ...reference, storageKey: storageKey || reference.storageKey };
        // A restored reference uses durable identity, never a saved blob URL.
        if (cache) {
            let data: string;
            try { data = await imageToDataUrl(resolved); }
            catch (error) {
                assertMediaSession(session);
                const detail = error instanceof Error ? error.message : "读取失败";
                throw new Error(`历史参考图片暂时无法读取，请稍后重试；若原素材已删除或丢失，请重新上传。详情：${detail}`);
            }
            if (!data) throw new Error("找不到历史参考图片，请重新上传该素材");
        }
        const dataUrl = cache
            ? await resolveImageUrl(resolved.storageKey, reference.dataUrl)
            : await resolveImageUrl(resolved.storageKey, reference.dataUrl).catch(() => reference.dataUrl);
        assertMediaSession(session);
        return { ...resolved, dataUrl };
    });
    assertMediaSession(session);
    return result;
}

export async function restoreHistoryFiles<T extends FileReference>(references: T[]): Promise<T[]> {
    const session = mediaSession();
    const result = await mapMedia(references, async (reference) => {
        const storageKey = await resolveMediaIdentity(reference);
        const url = await resolveMediaUrl(storageKey, reference.url).catch(() => reference.url);
        assertMediaSession(session);
        return { ...reference, storageKey: storageKey || reference.storageKey, url };
    });
    assertMediaSession(session);
    return result;
}
