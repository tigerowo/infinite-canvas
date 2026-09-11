"use client";
import { useEffect, useRef, useState } from "react";
import localforage from "localforage";
import { App } from "antd";
import { useUserStore } from "@/stores/use-user-store";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { assertReferenceLimit } from "@/extensions/media-reliability/reference-limit";
import { durableMediaSnapshot } from "@/extensions/media-reliability/snapshot";
import { claimMaterial, recordActivity, resolveMaterial, promoteReferences, readDraft, type Material } from "./api";
import { lifecycleEpoch } from "./session";
import { materialIds, objectId, contentDigest, remainingPasteText } from "./material-id";

export type DraftReference = { id: string; storageKey?: string; type: string; name: string; dataUrl?: string; url?: string };
type Draft = { id: string; prompt: string; references: DraftReference[]; epoch: number; version?: number; syncedContent?: string };
const disk = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_media_lifecycle_drafts" });
const queues = new Map<string, Promise<unknown>>();
const controls = new Map<string, { flush: () => Promise<Draft>; promoted: (version: number) => Promise<void> }>();
const signatureOf = (draft: Pick<Draft, "prompt" | "references">) => JSON.stringify(durableMediaSnapshot({ prompt: draft.prompt, references: draft.references }));
function enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(key, task);
    void task.finally(() => { if (queues.get(key) === task) queues.delete(key); }).catch(() => {});
    return task;
}

export async function loadDraftReferences(location: string) {
    const { token, user } = useUserStore.getState();
    if (!token || !user) return [];
    const epoch = await lifecycleEpoch(token);
    const saved = await disk.getItem<Draft>(`ext:media-lifecycle:draft:${user.id}:${location}`);
    if (saved?.epoch !== epoch) return [];
    return saved.references;
}

export async function protectSubmittedReferences(refs: { storageKey?: string }[], location?: string) {
    const { token, user } = useUserStore.getState();
    const files = [...new Set(refs.map((ref) => objectId(ref.storageKey)).filter(Boolean))];
    if (!files.length || !token || !user) return;
    const epoch = await lifecycleEpoch(token);
    const key = location ? `ext:media-lifecycle:draft:${user.id}:${location}` : "";
    const control = controls.get(key);
    const draft = control ? await control.flush() : null;
    if (useUserStore.getState().token !== token) throw new Error("账号已切换，请重新提交");
    await enqueue(key, async () => {
        const result = await promoteReferences({ kind: "request", id: crypto.randomUUID(), epoch, operationId: crypto.randomUUID(), files }, draft?.version ? draft.id : undefined, draft?.version);
        if (result.draft) await control?.promoted(result.draft.version);
    });
}

export function useMaterialDraft(location: string, prompt: string, references: DraftReference[], restore: (prompt: string, refs: DraftReference[]) => void, accept: (refs: DraftReference[], text: string) => void, validate?: (material: Material) => void, totalCount = references.length, captureSelector = "textarea,[contenteditable=true]") {
    const token = useUserStore((state) => state.token);
    const owner = useUserStore((state) => state.user?.id);
    const { message } = App.useApp();
    const [ready, setReady] = useState("");
    const current = useRef({ prompt, references, restore, accept, validate, totalCount });
    current.current = { prompt, references, restore, accept, validate, totalCount };
    const draft = useRef<Draft | null>(null);
    const busy = useRef(false);
    const key = owner ? `ext:media-lifecycle:draft:${owner}:${location}` : "";
    const signature = signatureOf({ prompt, references });

    useEffect(() => {
        let cancelled = false;
        setReady(""); draft.current = null;
        if (!key || !token) return;
        const checkCurrent = () => { if (cancelled || useUserStore.getState().token !== token) throw new Error("账号或输入位置已切换，草稿已保留"); };
        const controller = {
            flush: () => enqueue(key, async () => {
                checkCurrent();
                if (!draft.current) throw new Error("草稿正在恢复，请稍后重试");
                const snapshot = { ...draft.current, prompt: current.current.prompt, references: durableMediaSnapshot(current.current.references) };
                const content = await contentDigest(signatureOf(snapshot));
                await disk.setItem(key, snapshot);
                if (snapshot.syncedContent !== content) {
                    const files = [...new Set(snapshot.references.map((ref) => objectId(ref.storageKey)).filter(Boolean))];
                    const result = await recordActivity({ kind: "draft", id: snapshot.id, epoch: snapshot.epoch, operationId: crypto.randomUUID(), version: snapshot.version ?? 0, content, files });
                    checkCurrent();
                    snapshot.version = result.entity.version; snapshot.syncedContent = content;
                    if (result.missing?.length) message.warning("部分素材已丢失，请重新上传；本机草稿已保留");
                }
                draft.current = snapshot;
                await disk.setItem(key, snapshot);
                return snapshot;
            }),
            promoted: async (version: number) => {
                checkCurrent();
                if (!draft.current) return;
                draft.current.version = version;
                draft.current.syncedContent = await contentDigest(signatureOf(current.current));
                await disk.setItem(key, draft.current);
            },
        };
        controls.set(key, controller);
        void (async () => {
            const epoch = await lifecycleEpoch(token);
            const saved = await disk.getItem<Draft>(key);
            if (cancelled) return;
            if (saved && saved.epoch !== epoch) await disk.setItem(`${key}:recovery:${saved.epoch}:${Date.now()}`, saved);
            const value: Draft = saved?.epoch === epoch ? saved : { id: crypto.randomUUID(), epoch, prompt: current.current.prompt, references: current.current.references, version: 0 };
            if (value.version === undefined) value.version = (await readDraft(value.id)).entity.version;
            if (saved?.epoch === epoch || (!value.prompt && !value.references.length)) value.syncedContent ??= await contentDigest(signatureOf(value));
            const refs = await Promise.all(value.references.map(async (ref) => ({ ...ref, ...(ref.type.startsWith("image/") ? { dataUrl: await resolveImageUrl(ref.storageKey, ref.dataUrl || "").catch(() => ref.dataUrl || "") } : { url: await resolveMediaUrl(ref.storageKey, ref.url || "").catch(() => ref.url || "") }) })));
            if (cancelled || useUserStore.getState().token !== token) return;
            draft.current = value;
            current.current.restore(value.prompt, refs);
            await disk.setItem(key, value);
            setReady(key);
        })().catch((error) => { if (!cancelled) message.error(error instanceof Error ? error.message : "草稿恢复失败"); });
        return () => { cancelled = true; if (controls.get(key) === controller) controls.delete(key); };
    }, [key, token, message]);

    useEffect(() => {
        if (ready !== key || !draft.current || !token) return;
        const snapshot = { ...draft.current!, prompt, references: durableMediaSnapshot(references) };
        const localSave = enqueue(key, () => disk.setItem(key, { ...snapshot, version: draft.current?.version, syncedContent: draft.current?.syncedContent }));
        void localSave.catch(() => message.error("本机草稿保存失败，请检查浏览器存储空间"));
        const timer = window.setTimeout(() => {
            void controls.get(key)?.flush().catch((error) => message.error(error instanceof Error ? error.message : "草稿云端引用保存失败，本机副本已保留"));
        }, 400);
        return () => window.clearTimeout(timer);
    }, [key, ready, token, signature, message]);

    const paste = async (text: string) => {
        const ids = materialIds(text);
        if (!ids.length) return false;
        if (!token || !owner) throw new Error("请先登录后使用素材 ID");
        if (ready !== key || !draft.current) throw new Error("草稿正在恢复，请稍后粘贴");
        if (busy.current) throw new Error("素材 ID 正在读取，请稍候");
        busy.current = true;
        const source = draft.current;
        const added: DraftReference[] = [], accepted: string[] = [], errors: string[] = [];
        try {
            await controls.get(key)?.flush();
            const resolved = await Promise.allSettled(ids.map(resolveMaterial));
            await enqueue(key, async () => {
                const existing = new Set(current.current.references.map((ref) => objectId(ref.storageKey)));
                for (let index = 0; index < ids.length; index++) {
                    if (useUserStore.getState().token !== token || draft.current?.id !== source.id) throw new Error("账号或输入位置已切换，请重新粘贴");
                    try {
                        const result = resolved[index];
                        if (result.status === "rejected") throw result.reason;
                        const item = result.value;
                        if (existing.has(item.fileId)) { accepted.push(ids[index]); continue; }
                        assertReferenceLimit(current.current.totalCount + added.length + 1);
                        current.current.validate?.(item);
                        const claimed = await claimMaterial(item.shareId, { kind: "draft", id: source.id, epoch: source.epoch, operationId: crypto.randomUUID(), version: draft.current.version ?? 0 });
                        draft.current.version = claimed.draftVersion;
                        let url = "";
                        try { url = claimed.mimeType.startsWith("image/") ? await resolveImageUrl(claimed.storageKey, "") : await resolveMediaUrl(claimed.storageKey, ""); }
                        catch { errors.push("素材已加入，但预览暂不可用，请稍后重试"); }
                        added.push({ id: crypto.randomUUID(), name: claimed.name, type: claimed.mimeType, storageKey: claimed.storageKey, ...(claimed.mimeType.startsWith("image/") ? { dataUrl: url } : { url }) });
                        accepted.push(ids[index]); existing.add(item.fileId);
                    } catch (error) { errors.push(error instanceof Error ? error.message : "素材 ID 读取失败"); }
                }
            });
        } catch (error) { errors.push(error instanceof Error ? error.message : "草稿同步失败"); }
        finally { busy.current = false; }
        if (useUserStore.getState().token !== token || draft.current?.id !== source.id) throw new Error("账号或输入位置已切换，请重新粘贴");
        current.current.accept(added, remainingPasteText(text, accepted));
        if (errors.length) message.warning([...new Set(errors)].join("；"));
        else message.success(added.length ? `已加入 ${added.length} 个参考素材` : "这些素材已在当前输入中");
        return true;
    };
    const pasteRef = useRef(paste); pasteRef.current = paste;
    useEffect(() => {
        const listener = (event: ClipboardEvent) => {
            if (!(event.target instanceof HTMLElement) || !event.target.closest(captureSelector)) return;
            const text = event.clipboardData?.getData("text/plain") || "";
            if (!materialIds(text).length) return;
            event.preventDefault(); event.stopPropagation();
            const pasteToken = useUserStore.getState().token;
            const pasteDraft = draft.current?.id;
            void pasteRef.current(text).catch((error) => {
                if (useUserStore.getState().token === pasteToken && draft.current?.id === pasteDraft) current.current.accept([], text);
                message.error(error instanceof Error ? error.message : "素材 ID 读取失败");
            });
        };
        document.addEventListener("paste", listener, true);
        return () => document.removeEventListener("paste", listener, true);
    }, [message, captureSelector]);
    return paste;
}
