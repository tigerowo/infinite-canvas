import { apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

type Task = { id: string; parent_task_id?: string; status?: string };
export function isArchiveFailure(task?: Task | null, error = "") {
    const archive = task as (Task & { archive_error?: string; generation_status?: string }) | undefined;
    return Boolean(archive?.archive_error || (archive?.generation_status === "completed" && archive.status === "failed") || error.startsWith("内容已生成，保存到 OSS 失败"));
}

export async function retryTaskArchive(task: Task | null | undefined, kind: "image-task" | "audio-task" | "video-task", error = "") {
    if (!isArchiveFailure(task, error)) return false;
    const token = useUserStore.getState().token;
    if (!token || !task?.id) throw new Error("请登录并恢复原任务后再重试保存");
    const result = await apiPost<{ version: number }>("/api/extensions/media-lifecycle/tasks/retry-archive", { kind, id: task.parent_task_id || task.id, operationId: crypto.randomUUID() }, token);
    return result.version;
}
