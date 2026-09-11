export function createHistoryWriteQueue() {
    let pending: Promise<unknown> = Promise.resolve();
    return <T>(write: () => Promise<T>): Promise<T> => {
        const next = pending.then(write, write);
        pending = next.catch(() => undefined);
        return next;
    };
}

// A refresh owns only the records that have not changed since it started.
export function mergeHistoryRefresh<T extends { id: string; status: string; archiveRecovery?: number; task?: { archiveRecovery?: number } }>(base: T[], current: T[], incoming: T[]): T[] {
    const original = new Map(base.map((item) => [item.id, item]));
    const latest = new Map(current.map((item) => [item.id, item]));
    const merged = new Map<string, T>();
    for (const item of incoming) {
        const local = latest.get(item.id);
        if (original.has(item.id) && !local) continue;
        const revision = Math.max(item.archiveRecovery || 0, item.task?.archiveRecovery || 0);
        const localRevision = Math.max(local?.archiveRecovery || 0, local?.task?.archiveRecovery || 0);
        merged.set(item.id, local && local !== original.get(item.id) && revision <= localRevision ? local : preserveTerminalHistory(local, item));
    }
    for (const item of current) {
        if (!merged.has(item.id) && item !== original.get(item.id)) merged.set(item.id, item);
    }
    return [...merged.values()];
}
import { preserveTerminalHistory } from "../media-reliability/task-state";
