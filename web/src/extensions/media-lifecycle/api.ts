import { apiGet, apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

const base = "/api/extensions/media-lifecycle";
export type RetentionPolicy = { mode: "retention" | "forever"; days: number; execution: "observe" | "enforce"; version: number; epoch: number; clearing: boolean; storageReviewed: boolean; migratedAt: number };
export type Material = { shareId: string; fileId: string; name: string; mimeType: string; bytes: number; storageKey: string; expiresAt: number; draftVersion?: number };
export type Activity = { kind: string; id: string; operationId: string; epoch: number; version?: number; files?: string[]; content?: string };
export type ActivityResult = { entity: { version: number; lastUsedAt: number }; draft?: { version: number }; expiresAt: number; epoch: number; missing: string[] };
export type CleanupBatch = { id: string; kind: string; state: string; createdAt: number; updatedAt: number; error?: string };
export type CleanupPreview = { batch: CleanupBatch; files: number; records: number; bytes: number; preserved: string[] };
export type PolicyChangePreview = { id: string; files: number; records: number; bytes: number; additionalFiles: number; additionalRecords: number };
export type Capacity = { physicalBytes: number; physicalFiles: number; logicalBytes: number; pendingBytes: number };
export type LegacyScopeMigration = { scanned: number; migrated: number; skipped: number; errors?: string[] };

function token() { const value = useUserStore.getState().token; if (!value) throw new Error("请先登录后使用云端素材 ID"); return value; }
export function loadLifecycle() { return apiGet<RetentionPolicy>(base + "/state", undefined, token()); }
export function shareMaterial(fileId: string) { return apiPost<Material>(base + "/share", { fileId }, token()); }
export function resolveMaterial(shareId: string) { return apiGet<Material>(base + "/resolve/" + encodeURIComponent(shareId), undefined, token()); }
export function claimMaterial(shareId: string, activity: Activity) { return apiPost<Material>(base + "/claim", { ...activity, shareId }, token()); }
export function recordActivity(activity: Activity) { return apiPost<ActivityResult>(base + "/activity", activity, token()); }
export function readDraft(id: string) { return apiGet<ActivityResult>(base + "/draft/" + encodeURIComponent(id), undefined, token()); }
export function promoteReferences(activity: Activity, draftId?: string, draftVersion?: number) { return apiPost<ActivityResult>(base + "/promote", { ...activity, draftId, draftVersion }, token()); }
export function releaseReference(activity: Activity) { return apiPost<void>(base + "/release", activity, token()); }
export const adminLifecycle = {
    policy: (auth: string) => apiGet<RetentionPolicy>(base + "/admin/policy", undefined, auth),
    save: (auth: string, policy: RetentionPolicy, previewId?: string) => apiPost<RetentionPolicy>(base + "/admin/policy", { ...policy, previewId }, auth),
    previewPolicy: (auth: string, policy: RetentionPolicy) => apiPost<PolicyChangePreview>(base + "/admin/policy/preview", policy, auth),
    capacity: (auth: string) => apiGet<Capacity>(base + "/admin/capacity", undefined, auth),
    migrateStorageScopes: (auth: string) => apiPost<LegacyScopeMigration>(base + "/admin/migrate-storage-scopes", {}, auth),
    preview: (auth: string, kind: "expiry" | "clear") => apiPost<CleanupPreview>(base + "/admin/preview", { kind }, auth),
    batches: (auth: string) => apiGet<CleanupBatch[]>(base + "/admin/batches", undefined, auth),
    start: (auth: string, id: string, confirmation: string) => apiPost<void>(base + "/admin/batches/" + encodeURIComponent(id) + "/start", { confirmation }, auth),
    retry: (auth: string, id: string) => apiPost<void>(base + "/admin/batches/" + encodeURIComponent(id) + "/retry", {}, auth),
};
