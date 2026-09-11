export function materialIds(text: string) {
    return [...new Set(text.match(/\bmedia_[0-9a-f]{32}\b/g) || [])];
}

export function remainingPasteText(text: string, accepted: string[]) {
    const ids = new Set(accepted);
    return text.replace(/\bmedia_[0-9a-f]{32}\b/g, (id) => ids.has(id) ? "" : id);
}

export async function contentDigest(content: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function objectId(storageKey?: string) {
    if (!storageKey?.startsWith("server:")) return "";
    const id = storageKey.slice(7);
    return id && !/[\s/?&#]/.test(id) ? id : "";
}
