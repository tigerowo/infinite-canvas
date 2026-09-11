import { isSignedMediaURL } from "@/extensions/storage-access/signed-url";

export function durableMediaSnapshot<T>(value: T): T {
    if (Array.isArray(value)) return value.map(durableMediaSnapshot) as T;
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    const hasKey = (typeof record.storageKey === "string" && Boolean(record.storageKey)) || (data && typeof data.storageKey === "string" && Boolean(data.storageKey));
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
        hasKey && ["url", "dataUrl", "coverUrl", "content"].includes(key) && typeof item === "string" && (item.startsWith("blob:") || isSignedMediaURL(item))
            ? "" : durableMediaSnapshot(item),
    ])) as T;
}

export async function mapMedia<T, R>(items: T[], resolve: (item: T) => Promise<R>, concurrency = 4): Promise<R[]> {
    const result = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            result[index] = await resolve(items[index]);
        }
    }));
    return result;
}
