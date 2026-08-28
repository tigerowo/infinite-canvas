import { uploadImage } from "@/services/image-storage";

type InlineImage = {
    dataUrl: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type PersistInlineImage = (dataUrl: string) => Promise<Partial<InlineImage>>;

export async function persistInlineLogImages<T extends InlineImage>(images: T[], persist: PersistInlineImage = persistInlineImage): Promise<T[]> {
    if (!images.some(needsLocalPersistence)) return images;
    return Promise.all(images.map(async (image) => needsLocalPersistence(image) ? { ...image, ...(await persist(image.dataUrl)) } : image));
}

async function persistInlineImage(dataUrl: string): Promise<Partial<InlineImage>> {
    const stored = await uploadImage(dataUrl, { localOnly: true });
    return {
        dataUrl: stored.url,
        storageKey: stored.storageKey,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        mimeType: stored.mimeType,
    };
}

function needsLocalPersistence(image: InlineImage) {
    return !image.storageKey && image.dataUrl.startsWith("data:image/");
}
