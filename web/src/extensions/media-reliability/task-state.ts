// Lookup failures are recoverable and are not generation failures.
export const TASK_LOOKUP_RETRY = "任务状态暂不可用，将自动重试：";
export function taskLookupMessage(error: unknown) {
    return TASK_LOOKUP_RETRY + (error instanceof Error ? error.message : "网络或服务暂不可用");
}
export function isTaskLookupRetry(message?: string) {
    return Boolean(message?.startsWith(TASK_LOOKUP_RETRY) || message?.startsWith("视频已生成，保存到 OSS 失败"));
}
export function isTaskTerminal(status?: string) {
    return ["success", "completed", "error", "failed", "cancelled", "canceled", "成功", "失败"].includes(status || "");
}

type TaskTiming = {
    created_at?: string | number;
    createdAt?: string | number;
    started_at?: string | number;
    startedAt?: string | number;
    completed_at?: string | number;
    completedAt?: string | number;
    updated_at?: string | number;
    updatedAt?: string | number;
};

function timestamp(value?: string | number) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function hasTaskTerminalTimestamp(task?: TaskTiming) {
    // updated_at is often touched by provider polling even after completion.
    // It is not a stable end time and must never make a terminal duration grow
    // every time the history page refreshes.
    return Boolean(task && [task.completedAt, task.completed_at].some((value) => timestamp(value) > 0));
}

export function taskElapsedMs(createdAt: number, status: string, task?: TaskTiming, now = Date.now()) {
    const endedAt = isTaskTerminal(status)
        ? [task?.completedAt, task?.completed_at].map(timestamp).find(Boolean) || createdAt
        : now;
    return Math.max(0, endedAt - createdAt);
}

export function normalizeTaskElapsedMs(createdAt: number, status: string, storedMs: number, task?: TaskTiming) {
    if (!isTaskTerminal(status)) return Math.max(0, storedMs);
    const taskStartedAt = [task?.startedAt, task?.started_at, task?.createdAt, task?.created_at].map(timestamp).find(Boolean) || createdAt;
    const completedAt = [task?.completedAt, task?.completed_at].map(timestamp).find(Boolean);
    if (completedAt) return Math.max(0, completedAt - taskStartedAt);
    // Some providers expose only updated_at. Use it once to repair an old
    // inflated value, but never let a later refresh increase an already known
    // terminal duration.
    const updatedAt = [task?.updatedAt, task?.updated_at].map(timestamp).find(Boolean);
    if (updatedAt) {
        const candidate = Math.max(0, updatedAt - taskStartedAt);
        return storedMs > 0 ? Math.min(storedMs, candidate) : candidate;
    }
    return Math.max(0, storedMs);
}

export function mergeTaskElapsedMs(existingStatus: string, existingMs: number, incomingStatus: string, incomingMs: number, incomingHasTerminalTimestamp: boolean) {
    if (isTaskTerminal(incomingStatus)) {
        if (incomingHasTerminalTimestamp) return incomingMs;
        if (isTaskTerminal(existingStatus)) return existingMs;
    }
    return Math.max(existingMs, incomingMs);
}
export function shouldSyncTaskHistory(status: string, localClientTask: boolean) {
    return isTaskTerminal(status) || !localClientTask;
}

export function preserveTerminalHistory<T extends { status: string; archiveRecovery?: number; task?: { archiveRecovery?: number } }>(current: T | undefined, incoming: T): T {
    const revision = incoming.task?.archiveRecovery;
    if (revision !== undefined && Number.isSafeInteger(revision) && revision > (incoming.archiveRecovery || 0)) incoming = { ...incoming, archiveRecovery: revision };
    if (current && (incoming.archiveRecovery || 0) < (current.archiveRecovery || 0)) return current;
    if ((incoming.archiveRecovery || 0) > (current?.archiveRecovery || 0)) return incoming;
    if (current && ["success", "completed", "成功"].includes(current.status) && !["success", "completed", "成功"].includes(incoming.status)) return current;
    return current && isTaskTerminal(current.status) && !isTaskTerminal(incoming.status) ? current : incoming;
}
