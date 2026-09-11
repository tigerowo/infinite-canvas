import type { DraftReference } from "./use-material-draft";
import { loadDraftReferences } from "./use-material-draft";
import { useUserStore } from "@/stores/use-user-store";
import { knownLifecycleEpoch, lifecycleEpoch } from "./session";
import { CanvasNodeType, type CanvasAssistantReference } from "@/app/(user)/canvas/types";
import type { NodeGenerationInput } from "@/app/(user)/canvas/components/canvas-node-generation";

const drafts = new Map<string, DraftReference[]>();
const scoped = (location: string) => { const { token, user } = useUserStore.getState(); return `${user?.id || "guest"}:${knownLifecycleEpoch(token || "") || 0}:${location}`; };
export function setCanvasDraft(location: string, references: DraftReference[]) { drafts.set(scoped(location), references); }
export async function canvasDraftInputs(location: string): Promise<NodeGenerationInput[]> { const token = useUserStore.getState().token; if (token) await lifecycleEpoch(token); return draftInputs(drafts.get(scoped(location)) || await loadDraftReferences(location)); }
useUserStore.subscribe((state, previous) => { if (state.token !== previous.token) drafts.clear(); });
if (typeof window !== "undefined") window.addEventListener("ext:media-lifecycle:conflict", () => drafts.clear());
export function draftInputs(refs: DraftReference[]): NodeGenerationInput[] {
    return refs.flatMap((ref): NodeGenerationInput[] => {
        const base = { nodeId: ref.id, title: ref.name };
        if (ref.type.startsWith("image/")) return [{ ...base, type: "image", image: { ...ref, dataUrl: ref.dataUrl || "" } }];
        if (ref.type.startsWith("video/")) return [{ ...base, type: "video", video: { ...ref, url: ref.url || "" } }];
        if (ref.type.startsWith("audio/")) return [{ ...base, type: "audio", audio: { ...ref, url: ref.url || "" } }];
        return [];
    });
}
export function assistantDraftReference(ref: DraftReference): CanvasAssistantReference {
    return { id: ref.id, title: ref.name, label: `@云素材${ref.id}`, type: ref.type.startsWith("image/") ? CanvasNodeType.Image : ref.type.startsWith("video/") ? CanvasNodeType.Video : CanvasNodeType.Audio, mimeType: ref.type, storageKey: ref.storageKey, dataUrl: ref.dataUrl, url: ref.url };
}
export function assistantDraftInputs(refs: CanvasAssistantReference[]): NodeGenerationInput[] {
    return draftInputs(refs.map((ref) => ({ id: ref.id, name: ref.title, type: ref.mimeType || `${ref.type}/*`, storageKey: ref.storageKey, dataUrl: ref.dataUrl, url: ref.url })));
}
