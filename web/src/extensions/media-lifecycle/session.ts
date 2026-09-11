// One epoch per authenticated page session. A newer response never silently
// authorizes replaying edits created before an administrator's clear.
const sessions = new Map<string, Promise<number>>();
const epochs = new Map<string, number>();
const stale = new Set<string>();

export function knownLifecycleEpoch(token: string) { return stale.has(token) ? undefined : epochs.get(token); }

export class LifecycleConflict extends Error {
    constructor() { super("云端数据已清理，请刷新页面后继续；未同步的编辑已保留在本机恢复副本中"); }
}

export async function lifecycleEpoch(token: string): Promise<number> {
    if (!token) return 1;
    if (stale.has(token)) throw new LifecycleConflict();
    const known = epochs.get(token);
    if (known) return known;
    let request = sessions.get(token);
    if (!request) {
        request = fetch("/api/extensions/media-lifecycle/state", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).then(async (response) => {
            const result = await response.json();
            if (!response.ok || result.code !== 0 || !Number.isSafeInteger(result.data?.epoch)) throw new Error(result.msg || "无法确认云端同步状态，请稍后重试");
            if (result.data.clearing) throw new Error("管理员正在清空业务数据，请稍后重试");
            epochs.set(token, result.data.epoch);
            return result.data.epoch as number;
        });
        sessions.set(token, request);
        void request.finally(() => sessions.delete(token)).catch(() => {});
    }
    return request;
}

export function lifecycleHeaders(token: string): Record<string, string> {
    if (!token) return {};
    if (stale.has(token)) throw new LifecycleConflict();
    const epoch = epochs.get(token);
    return { "X-Media-Epoch": String(epoch || 1) };
}

export function inspectLifecycleEpoch(token: string, received: unknown) {
    if (!token || !received) return;
    const epoch = Number(received);
    const expected = epochs.get(token);
    if (expected && Number.isSafeInteger(epoch) && epoch !== expected) {
        stale.add(token);
        if (typeof window !== "undefined") window.dispatchEvent(new Event("ext:media-lifecycle:conflict"));
        throw new LifecycleConflict();
    }
}
