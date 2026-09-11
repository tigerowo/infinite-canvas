"use client";
import { createHistoryStore } from "@/extensions/media-lifecycle/history-store";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { fetchUserAssetData, syncUserAssetData } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import { durableMediaSnapshot, mapMedia } from "@/extensions/media-reliability/snapshot";
import { assertMediaSession, mediaSession } from "@/extensions/media-reliability/cache";
import { knownLifecycleEpoch, lifecycleEpoch } from "@/extensions/media-lifecycle/session";
import { mergeAssetCollection, synchronizeAssetCollection, type AssetCollection } from "@/extensions/media-lifecycle/asset-sync";
import { createHistoryWriteQueue } from "@/extensions/media-lifecycle/history-write";

export type AssetKind = "text" | "image" | "video" | "audio";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; bytes?: number; mimeType: string; durationMs?: number } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    assets: Asset[];
    remoteSnapshot: AssetCollection<Asset> | null;
    syncError: string;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    hydrateAccountAssets: (token: string, syncEnabled?: boolean) => Promise<void>;
    syncAccountAssets: (token: string) => Promise<void>;
    stopAccountAssetSync: () => void;
    cleanupImages: (extra?: unknown, storageKeys?: ReadonlyMap<string, string>, ownerToken?: string) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let activeAssetSyncToken = "";
let accountAssetSyncEnabled = false;
let syncTimer: number | null = null;
let activeAssetStorageScope = "";
let assetScopeLoading = false;
let assetScopeLoad: Promise<void> = Promise.resolve();
let assetScopeGeneration = 0;
const enqueueAssetSync = createHistoryWriteQueue();
const enqueueAssetStorage = createHistoryWriteQueue();

async function resolveStoredAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
    if (asset.kind === "audio" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
    if (asset.kind !== "image") return asset;
    if (asset.data.storageKey)
        return {
            ...asset,
            coverUrl: await resolveImageUrl(asset.data.storageKey, asset.coverUrl),
            data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
        };
    return asset;
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async () => {
        if (!activeAssetStorageScope) return null;
        const value = await localForageStorage.getItem(activeAssetStorageScope);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await mapMedia(parsed.state.assets, (asset) => resolveStoredAsset(asset).catch(() => durableMediaSnapshot(asset)));
        return parsed;
    },
    setItem: (_name, value) => {
        if (!assetScopeLoading && activeAssetStorageScope) {
            const key = activeAssetStorageScope, encoded = JSON.stringify(durableMediaSnapshot(value));
            return enqueueAssetStorage(async () => { await localForageStorage.setItem(key, encoded); });
        }
    },
    removeItem: () => activeAssetStorageScope ? localForageStorage.removeItem(activeAssetStorageScope) : undefined,
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            assets: [],
            remoteSnapshot: null,
            syncError: "",
            addAsset: (asset) => {
                assertAssetScopeReady();
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                scheduleAssetSync(get);
                return id;
            },
            updateAsset: (id, patch) => {
                assertAssetScopeReady();
                set((state) => {
                    const assets = state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset));
                    window.setTimeout(() => scheduleAssetSync(get), 0);
                    return { assets };
                });
            },
            removeAsset: (id) => {
                assertAssetScopeReady();
                set((state) => {
                    const deletedAsset = state.assets.find((asset) => asset.id === id);
                    const assets = state.assets.filter((asset) => asset.id !== id);

                    if (deletedAsset && deletedAsset.kind !== "text" && deletedAsset.data.storageKey) {
                        const key = deletedAsset.data.storageKey;
                        const deletedBy = mediaSession();
                        window.setTimeout(async () => {
                            if (deletedBy.token !== useUserStore.getState().token) return;
                            if (deletedBy.token) {
                                try { await get().syncAccountAssets(deletedBy.token); } catch { return; }
                                // Server references and the retention worker own cloud deletion.
                                return;
                            }
                            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                            const usedKeys = new Set<string>();
                            // 收集其余资产的 storageKey
                            assets.forEach((a) => {
                                if (a.kind !== "text" && a.data.storageKey) usedKeys.add(a.data.storageKey);
                            });
                            // 收集画布中引用的 storageKey
                            const projects = useCanvasStore.getState().projects;
                            const { collectImageStorageKeys } = await import("@/services/image-storage");
                            const { collectMediaStorageKeys } = await import("@/services/file-storage");
                            collectImageStorageKeys(projects, usedKeys);
                            collectMediaStorageKeys(projects, usedKeys);

                            // 收集本地/云端生图历史与视频历史中的 storageKey，避免生成结果卡片失效
                            try {
                                const imageLogStore = createHistoryStore("image_generation_logs");
                                await imageLogStore.iterate((log: any) => {
                                    if (log) {
                                        if (Array.isArray(log.images)) {
                                            log.images.forEach((img: any) => {
                                                if (img && img.storageKey) usedKeys.add(img.storageKey);
                                            });
                                        }
                                        if (Array.isArray(log.references)) {
                                            log.references.forEach((ref: any) => {
                                                if (ref && ref.storageKey) usedKeys.add(ref.storageKey);
                                            });
                                        }
                                    }
                                });
                            } catch (e) {
                                console.error("Error iterating image_generation_logs", e);
                            }

                            try {
                                const videoLogStore = createHistoryStore("video_generation_logs");
                                await videoLogStore.iterate((log: any) => {
                                    if (log) {
                                        if (log.video && log.video.storageKey) {
                                            usedKeys.add(log.video.storageKey);
                                        }
                                        if (Array.isArray(log.references)) {
                                            log.references.forEach((ref: any) => {
                                                if (ref && ref.storageKey) usedKeys.add(ref.storageKey);
                                            });
                                        }
                                    }
                                });
                            } catch (e) {
                                console.error("Error iterating video_generation_logs", e);
                            }

                            // 若全站没有其他地方再引用此 storageKey，则执行真正的物理删除
                            if (deletedBy.token !== useUserStore.getState().token) return;
                            if (!usedKeys.has(key)) {
                                if (key.startsWith("image:") || key.startsWith("server:")) {
                                    const { deleteStoredImages } = await import("@/services/image-storage");
                                    await deleteStoredImages([key]);
                                }
                                if (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("server:")) {
                                    const { deleteStoredMedia } = await import("@/services/file-storage");
                                    await deleteStoredMedia([key]);
                                }
                            }
                        }, 0);
                    }

                    window.setTimeout(() => scheduleAssetSync(get), 0);
                    return { assets };
                });
            },
            hydrateAccountAssets: async (token, syncEnabled = false) => {
                if (!token || useUserStore.getState().token !== token) return;
                await assetScopeLoad;
                if (!activeAssetStorageScope) { loadAssetScope(); await assetScopeLoad; }
                if (useUserStore.getState().token !== token) return;
                activeAssetSyncToken = token;
                accountAssetSyncEnabled = syncEnabled;
                await get().syncAccountAssets(token);
            },
            syncAccountAssets: async (token) => {
                if (!token || !accountAssetSyncEnabled) return;
                const session = mediaSession();
                const generation = assetScopeGeneration;
                if (session.token !== token) return;
                await enqueueAssetSync(async () => {
                    await assetScopeLoad;
                    const epoch = await lifecycleEpoch(token);
                    const check = () => {
                        assertMediaSession(session);
                        assertAssetScopeReady();
                        if (generation !== assetScopeGeneration) throw new Error("素材账号已切换，请重新载入");
                        if (knownLifecycleEpoch(token) !== epoch || activeAssetSyncToken !== token) throw new Error("素材同步范围已变化，请重新载入；本机副本仍保留");
                    };
                    try {
                        check();
                        const submitted = durableMediaSnapshot(get().assets);
                        const accepted = await synchronizeAssetCollection({ base: get().remoteSnapshot, local: submitted, check,
                            read: () => fetchUserAssetData<AssetCollection<Asset>>(token),
                            write: (data) => syncUserAssetData(token, data),
                        });
                        const resolved = await mapMedia(accepted.assets, (asset) => resolveStoredAsset(asset).catch(() => durableMediaSnapshot(asset)));
                        check();
                        const merged = mergeAssetCollection(submitted, durableMediaSnapshot(get().assets), accepted.assets);
                        const resolvedByID = new Map(resolved.map((asset) => [asset.id, asset]));
                        const acceptedByID = new Map(accepted.assets.map((asset) => [asset.id, asset]));
                        set({ assets: merged.map((asset) => asset === acceptedByID.get(asset.id) ? resolvedByID.get(asset.id)! : asset), remoteSnapshot: accepted, syncError: "" });
                    } catch (error) {
                        if (generation === assetScopeGeneration && useUserStore.getState().token === token) set({ syncError: error instanceof Error ? error.message : "素材同步失败，本机修改已保留" });
                        throw error;
                    }
                });
            },
            stopAccountAssetSync: () => {
                activeAssetSyncToken = "";
                accountAssetSyncEnabled = false;
                if (syncTimer) window.clearTimeout(syncTimer);
                syncTimer = null;
            },
            cleanupImages: (extra, storageKeys, ownerToken) => {
                const session = mediaSession();
                if (ownerToken !== undefined && ownerToken !== session.token) return;
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    const { loadLocalAgentSkills, useAgentSkillStore } = await import("@/stores/use-agent-skill-store");
                    const logKeys: string[] = [];
                    try {
                        const imageLogStore = createHistoryStore("image_generation_logs");
                        await imageLogStore.iterate((log: any) => {
                            if (log) {
                                if (Array.isArray(log.images)) {
                                    log.images.forEach((img: any) => {
                                        if (img && img.storageKey) logKeys.push(img.storageKey);
                                    });
                                }
                                if (Array.isArray(log.references)) {
                                    log.references.forEach((ref: any) => {
                                        if (ref && ref.storageKey) logKeys.push(ref.storageKey);
                                    });
                                }
                            }
                        });
                        const videoLogStore = createHistoryStore("video_generation_logs");
                        await videoLogStore.iterate((log: any) => {
                            if (log) {
                                if (log.video && log.video.storageKey) {
                                    logKeys.push(log.video.storageKey);
                                }
                                if (Array.isArray(log.references)) {
                                    log.references.forEach((ref: any) => {
                                        if (ref && ref.storageKey) logKeys.push(ref.storageKey);
                                    });
                                }
                            }
                        });
                    } catch (e) {
                        console.error("Error gathering log keys in cleanupImages", e);
                        return;
                    }

                    try {
                        await useAgentSkillStore.getState().loadSkills();
                        const skillStore = useAgentSkillStore.getState();
                        const localSkills = useUserStore.getState().token ? await loadLocalAgentSkills() : [];
                        assertMediaSession(session);
                        await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, skills: [...skillStore.systemSkills, ...skillStore.userSkills, ...localSkills], extra, logKeys }, storageKeys, session.token);
                        assertMediaSession(session);
                    } catch (error) {
                        console.error("Error gathering Skill keys in cleanupImages", error);
                        return;
                    }
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra, logKeys });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            skipHydration: true,
            partialize: (state) => ({ assets: state.assets, remoteSnapshot: state.remoteSnapshot }) as StorageValue<AssetStore>["state"],
        },
    ),
);

function assetScopeKey() {
    const { token, userId } = mediaSession();
    const epoch = token ? knownLifecycleEpoch(token) : 1;
    if (!useUserStore.getState().isReady || (token && !userId) || !epoch) return "";
    return `ext:media-lifecycle:assets:${token ? `user:${encodeURIComponent(userId!)}` : "guest"}:${epoch}`;
}

function assertAssetScopeReady() {
    if (assetScopeLoading || !activeAssetStorageScope || activeAssetStorageScope !== assetScopeKey()) throw new Error("正在载入当前账号的素材，请稍后重试；原有本机副本仍保留");
}

function loadAssetScope() {
    const session = mediaSession();
    const generation = ++assetScopeGeneration;
    assetScopeLoading = true;
    activeAssetStorageScope = "";
    useAssetStore.getState().stopAccountAssetSync();
    useAssetStore.setState({ assets: [], remoteSnapshot: null, syncError: "" });
    assetScopeLoad = (async () => {
        if (!useUserStore.getState().isReady) return;
        if (session.token) await lifecycleEpoch(session.token);
        if (generation !== assetScopeGeneration) return;
        assertMediaSession(session);
        const key = assetScopeKey();
        if (!key) return;
        const raw = await enqueueAssetStorage(async () => localForageStorage.getItem(key));
        if (generation !== assetScopeGeneration) return;
        assertMediaSession(session);
        if (key !== assetScopeKey()) return;
        const saved = raw ? JSON.parse(raw) as StorageValue<AssetStore> : null;
        activeAssetStorageScope = key;
        useAssetStore.setState({ assets: saved?.state.assets || [], remoteSnapshot: saved ? saved.state.remoteSnapshot || null : { assets: [], revision: "initial" } });
        assetScopeLoading = false;
    })().catch((error) => {
        if (generation === assetScopeGeneration) useAssetStore.setState({ syncError: error instanceof Error ? error.message : "本机素材载入失败" });
    });
}

useUserStore.subscribe((next, previous) => {
    if (next.token !== previous.token || next.user?.id !== previous.user?.id || next.isReady !== previous.isReady) loadAssetScope();
});
if (typeof window !== "undefined") loadAssetScope();

function scheduleAssetSync(get: () => AssetStore) {
    if (!activeAssetSyncToken || !accountAssetSyncEnabled || typeof window === "undefined") return;
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        void get().syncAccountAssets(activeAssetSyncToken).catch(() => {});
    }, 600);
}

export function mergeAssets(remoteAssets: Asset[], localAssets: Asset[]) {
    const records = new Map<string, Asset>();
    [...localAssets, ...remoteAssets].forEach((asset) => {
        const previous = records.get(asset.id);
        if (!previous || Date.parse(asset.updatedAt || "") >= Date.parse(previous.updatedAt || "")) {
            records.set(asset.id, asset);
        }
    });
    return Array.from(records.values()).sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
}
