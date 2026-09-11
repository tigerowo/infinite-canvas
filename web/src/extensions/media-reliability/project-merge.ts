import { isTaskLookupRetry, isTaskTerminal } from "./task-state";

// Apply only edits made since the browser's last snapshot. A remote deletion wins
// over an edit to the deleted item; unrelated nodes and fields remain intact.
export function mergeProjectChanges<T>(base: T, local: T, remote: T): T {
    return mergeValue(base, local, remote) as T;
}

function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
    if (JSON.stringify(base) === JSON.stringify(local)) return remote;
    if (local === undefined || (remote === undefined && base !== undefined)) return undefined;
    if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base) && [...base, ...local, ...remote].every(hasId)) {
        const before = new Map(base.map((item) => [item.id, item]));
        const after = new Map(local.map((item) => [item.id, item]));
        const current = new Map(remote.map((item) => [item.id, item]));
        return [...new Set([...current.keys(), ...after.keys()])]
            .map((id) => mergeValue(before.get(id), after.get(id), current.get(id)))
            .filter((item) => item !== undefined);
    }
    if (isRecord(local) && isRecord(remote) && isRecord(base)) {
        const merged = Object.fromEntries([...new Set([...Object.keys(remote), ...Object.keys(local)])]
            .map((key) => [key, mergeValue(base[key], local[key], remote[key])])
            .filter(([, value]) => value !== undefined));
        const localRecovery = Number(local.archiveRecovery || 0), remoteRecovery = Number(remote.archiveRecovery || 0);
        if (remote.startedAt === local.startedAt && remoteRecovery > localRecovery) {
            for (const key of ["status", "content", "storageKey", "progress", "errorDetails", "durationMs", "archiveRecovery"]) {
                if (key in remote) merged[key] = remote[key];
                else delete merged[key];
            }
        } else if (localRecovery <= remoteRecovery && isTaskTerminal(remote.status as string) && !isTaskLookupRetry(remote.errorDetails as string) && (local.status === "loading" || isTaskLookupRetry(local.errorDetails as string)) && remote.startedAt === local.startedAt) {
            for (const key of ["status", "content", "storageKey", "progress", "errorDetails", "durationMs"]) {
                if (key in remote) merged[key] = remote[key];
                else delete merged[key];
            }
        }
        return merged;
    }
    return local;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function hasId(value: unknown): value is { id: string } { return isRecord(value) && typeof value.id === "string"; }
