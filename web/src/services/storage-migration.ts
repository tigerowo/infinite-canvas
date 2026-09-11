import localforage from "localforage";
import { createHistoryStore } from "@/extensions/media-lifecycle/history-store";
import { uploadImage } from "./image-storage";
import { uploadMediaBlob } from "./file-storage";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { syncUserImageHistory } from "./api/user-config";
import { saveVideoGenerationLogs } from "./api/generation-logs";
import { assertMediaSession, mediaSession } from "@/extensions/media-reliability/cache";
import { knownLifecycleEpoch, lifecycleEpoch } from "@/extensions/media-lifecycle/session";

export async function checkLocalAssetsExist(): Promise<boolean> {
    const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
    const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

    let found = false;
    try {
        await imageStore.iterate((_val, key) => {
            if (key.startsWith("image:")) {
                found = true;
                return true; // Stop iteration early
            }
        });
        if (found) return true;

        await mediaStore.iterate((_val, key) => {
            if (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("asset-video:") || key.startsWith("asset-audio:")) {
                found = true;
                return true; // Stop iteration early
            }
        });
    } catch (e) {
        console.error("checkLocalAssetsExist error", e);
    }
    return found;
}

export async function migrateLocalAssetsToCloud(
    onProgress: (current: number, total: number) => void
): Promise<void> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    const session = mediaSession();
    const epoch = await lifecycleEpoch(token);
    const check = () => {
        assertMediaSession(session);
        if (knownLifecycleEpoch(token) !== epoch) throw new Error("云端数据范围已变化，请刷新后重试；本机原件仍保留");
    };
    check();

    const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
    const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

    // 1. Gather all local keys and their blobs
    const imagesToUpload: { key: string; blob: Blob }[] = [];
    await imageStore.iterate((blob, key) => {
        if (key.startsWith("image:") && blob instanceof Blob) {
            imagesToUpload.push({ key, blob });
        }
    });

    const mediaToUpload: { key: string; blob: Blob }[] = [];
    await mediaStore.iterate((blob, key) => {
        if ((key.startsWith("file:") || key.startsWith("video:") || key.startsWith("asset-video:") || key.startsWith("asset-audio:")) && blob instanceof Blob) {
            mediaToUpload.push({ key, blob });
        }
    });

    const total = imagesToUpload.length + mediaToUpload.length;
    if (total === 0) return;

    let current = 0;
    const keyMapping = new Map<string, { serverKey: string; url: string }>();

    // 2. Upload images to S3
    for (const item of imagesToUpload) {
        check();
        try {
            const result = await uploadImage(item.blob);
            check();
            if (result.storageKey && result.storageKey.startsWith("server:")) {
                keyMapping.set(item.key, { serverKey: result.storageKey, url: result.url });
            }
        } catch (e) {
            check();
            console.error(`Failed to migrate image ${item.key}`, e);
        }
        current++;
        onProgress(current, total);
    }

    // 3. Upload media to S3
    for (const item of mediaToUpload) {
        check();
        try {
            const ext = item.blob.type.split("/")[1] || "mp4";
            const filename = `media-${item.key.replace(":", "-")}.${ext}`;
            const result = await uploadMediaBlob(item.blob, filename);
            check();
            if (result.storageKey && result.storageKey.startsWith("server:")) {
                keyMapping.set(item.key, { serverKey: result.storageKey, url: result.url });
            }
        } catch (e) {
            check();
            console.error(`Failed to migrate media ${item.key}`, e);
        }
        current++;
        onProgress(current, total);
    }

    if (keyMapping.size === 0) return;
    check();

    // Helper to replace keys and blob URLs in any text/json
    const replaceKeysInString = async (jsonStr: string): Promise<string> => {
        let resultStr = jsonStr;
        const { resolveImageUrl } = await import("./image-storage");
        const { resolveMediaUrl } = await import("./file-storage");

        for (const [localKey, value] of keyMapping.entries()) {
            resultStr = resultStr.replaceAll(`"${localKey}"`, `"${value.serverKey}"`);
            resultStr = resultStr.replaceAll(`:${localKey}`, `:${value.serverKey}`);
            resultStr = resultStr.replaceAll(localKey, value.serverKey);

            if (localKey.startsWith("image:")) {
                const localBlobUrl = await resolveImageUrl(localKey);
                if (localBlobUrl && localBlobUrl.startsWith("blob:")) {
                    resultStr = resultStr.replaceAll(localBlobUrl, value.url);
                }
            } else if (localKey.startsWith("file:") || localKey.startsWith("video:") || localKey.startsWith("asset-video:") || localKey.startsWith("asset-audio:")) {
                const localBlobUrl = await resolveMediaUrl(localKey);
                if (localBlobUrl && localBlobUrl.startsWith("blob:")) {
                    resultStr = resultStr.replaceAll(localBlobUrl, value.url);
                }
            }
        }
        return resultStr;
    };

    // 4. Update Canvas projects
    const canvasProjects = useCanvasStore.getState().projects;
    if (canvasProjects.length > 0) {
        try {
            const canvasStr = JSON.stringify({
                projects: canvasProjects,
            });
            const replacedCanvasStr =
                await replaceKeysInString(canvasStr);
            const nextCanvas = JSON.parse(replacedCanvasStr);
            check();
            const finalCanvas = {
                projects: nextCanvas.projects || [],
            };
            await localforage
                .createInstance({
                    name: "infinite-canvas",
                    storeName: "app_state",
                })
                .setItem(
                    "infinite-canvas:canvas_store",
                    JSON.stringify({
                        state: finalCanvas,
                        version: 0,
                    }),
                );
            useCanvasStore.setState(finalCanvas);
            await useCanvasStore.getState().syncWithRemote(
                token,
                true,
            );
        } catch (error) {
            console.error(
                "Failed to migrate canvas projects",
                error,
            );
        }
    }

    // 5. Update Asset store
    const assets = useAssetStore.getState().assets;
    if (assets.length > 0) {
        try {
            const assetsStr = JSON.stringify({ assets });
            const replacedAssetsStr = await replaceKeysInString(assetsStr);
            const nextAssets = JSON.parse(replacedAssetsStr);
            check();
            const migrated = new Map<string, typeof assets[number]>((nextAssets.assets as typeof assets).map((asset) => [asset.id, asset]));
            const original = new Map(assets.map((asset) => [asset.id, asset]));
            const finalAssets = { assets: useAssetStore.getState().assets.map((asset) => asset === original.get(asset.id) ? migrated.get(asset.id)! : asset) };
            useAssetStore.setState(finalAssets);
            await useAssetStore.getState().syncAccountAssets(token);
        } catch (e) {
            console.error("Failed to migrate assets", e);
        }
    }

    // 6. Update Image Generation Logs
    const imageLogStore = createHistoryStore("image_generation_logs");
    check();
    const imageCategoryStore = createHistoryStore("image_generation_categories");
    const localLogs: any[] = [];
    await imageLogStore.iterate((value) => {
        localLogs.push(value);
    });
    const localCategories = (await imageCategoryStore.getItem<any[]>("infinite-canvas:image_generation_categories")) || [];

    if (localLogs.length > 0 || localCategories.length > 0) {
        try {
            const logsStr = JSON.stringify({ logs: localLogs, categories: localCategories });
            const replacedLogsStr = await replaceKeysInString(logsStr);
            const nextLogsData = JSON.parse(replacedLogsStr);
            check();

            // Save locally
            await imageLogStore.clear();
            await Promise.all(
                nextLogsData.logs.map((log: any) => imageLogStore.setItem(log.id, log))
            );
            await imageCategoryStore.setItem("infinite-canvas:image_generation_categories", nextLogsData.categories);

            // Sync to server
            await syncUserImageHistory(token, { logs: nextLogsData.logs, categories: nextLogsData.categories });
        } catch (e) {
            console.error("Failed to migrate image logs", e);
        }
    }

    // 7. Update Video Generation Logs
    const videoLogStore = createHistoryStore("video_generation_logs");
    check();
    const localVideoLogs: any[] = [];
    await videoLogStore.iterate((value) => {
        localVideoLogs.push(value);
    });

    if (localVideoLogs.length > 0) {
        try {
            const videoLogsStr = JSON.stringify({ logs: localVideoLogs });
            const replacedVideoLogsStr = await replaceKeysInString(videoLogsStr);
            const nextVideoLogsData = JSON.parse(replacedVideoLogsStr);
            check();

            // Save locally
            await videoLogStore.clear();
            await Promise.all(
                nextVideoLogsData.logs.map((log: any) => videoLogStore.setItem(log.id, log))
            );

            // Sync to server
            await saveVideoGenerationLogs(token, nextVideoLogsData.logs);
        } catch (e) {
            console.error("Failed to migrate video logs", e);
        }
    }

    // 8. Cache old local files under the new server keys
    for (const [localKey, value] of keyMapping.entries()) {
        check();
        if (localKey.startsWith("image:")) {
            const blob = await imageStore.getItem<Blob>(localKey);
            if (blob) {
                check();
                await imageStore.setItem(`ext:media-reliability:user:${session.userId}:${value.serverKey}`, blob);
            }
        } else if (localKey.startsWith("file:") || localKey.startsWith("video:") || localKey.startsWith("asset-video:") || localKey.startsWith("asset-audio:")) {
            const blob = await mediaStore.getItem<Blob>(localKey);
            if (blob) {
                check();
                await mediaStore.setItem(`ext:media-reliability:user:${session.userId}:${value.serverKey}`, blob);
            }
        }
    }
}
