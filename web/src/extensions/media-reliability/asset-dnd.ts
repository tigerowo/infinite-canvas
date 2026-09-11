import type { DragEvent } from "react";
import type { InsertAssetPayload } from "@/app/(user)/canvas/types";
import type { Asset } from "@/stores/use-asset-store";
import type { AssetLibraryItem } from "@/services/api/assets";

export const ASSET_DND_TYPE = "application/x-infinite-canvas-asset";

export function isFileDrag(event: DragEvent) {
    return event.dataTransfer.files.length > 0 || Array.from(event.dataTransfer.types || []).some((type) => type.toLowerCase() === "files");
}

export function readDroppedFiles(event: DragEvent) {
    return event.dataTransfer.files.length ? event.dataTransfer.files : null;
}

export function hasSupportedDrop(event: DragEvent) {
    const types = Array.from(event.dataTransfer.types || []);
    return isFileDrag(event) || types.includes(ASSET_DND_TYPE) || types.includes("application/json") || types.includes("text/plain");
}

export function writeAssetDrag(event: DragEvent, payload: InsertAssetPayload) {
    event.dataTransfer.effectAllowed = "copy";
    const encoded = JSON.stringify(payload);
    event.dataTransfer.setData(ASSET_DND_TYPE, encoded);
    // Some Chromium/WebKit surfaces strip custom MIME types while dragging
    // between nested portals. Keep a JSON fallback so workbenches can still
    // accept the same asset when the proprietary type is unavailable.
    event.dataTransfer.setData("application/json", encoded);
    event.dataTransfer.setData("text/plain", encoded);
}

export function readAssetDrag(event: DragEvent): InsertAssetPayload | null {
    const value = event.dataTransfer.getData(ASSET_DND_TYPE) || event.dataTransfer.getData("application/json") || event.dataTransfer.getData("text/plain");
    if (!value) return null;
    try {
        const payload = JSON.parse(value) as InsertAssetPayload;
        return payload && typeof payload === "object" && "kind" in payload ? payload : null;
    } catch {
        return null;
    }
}

export function userAssetDragPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id, source: "asset" };
    if (asset.kind === "image") return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" };
    return { kind: asset.kind, url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, bytes: asset.data.bytes, mimeType: asset.data.mimeType, ...(asset.kind === "video" ? { width: asset.data.width, height: asset.data.height } : { durationMs: asset.data.durationMs }), source: "asset" };
}

export function libraryAssetDragPayload(asset: AssetLibraryItem): InsertAssetPayload {
    if (asset.type === "text") return { kind: "text", content: asset.content, title: asset.title, assetId: asset.id, source: "library" };
    if (asset.type === "image") return { kind: "image", dataUrl: asset.url, title: asset.title, assetId: asset.id, mimeType: "image/*", source: "library" };
    return { kind: asset.type, url: asset.url, title: asset.title, assetId: asset.id, mimeType: asset.type === "video" ? "video/mp4" : "audio/mpeg", source: "library" };
}
