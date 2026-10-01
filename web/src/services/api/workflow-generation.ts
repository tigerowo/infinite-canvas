import { readFileAsDataUrl } from "@/lib/image-utils";
import type { WorkflowCapability, WorkflowMediaSlotMode, WorkflowRef } from "@/lib/workflow-channel";

export type WorkflowRunInput = {
    ref: WorkflowRef;
    expectedCapability: WorkflowCapability;
    prompt: string;
    systemPrompt?: string;
    fieldValues?: Record<string, unknown>;
    referenceImages?: string[];
    referenceVideos?: string[];
    referenceAudios?: string[];
    mask?: string;
    size?: string;
    quality?: string;
    transparentBackground?: boolean;
    count?: number;
    videoSeconds?: string;
    videoQuality?: string;
    videoGenerateAudio?: boolean;
    videoWatermark?: boolean;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: number;
    audioInstructions?: string;
    source?: string;
    sourceId?: string;
    nodeId?: string;
    clientTaskId?: string;
    mediaSlotModes?: Record<string, WorkflowMediaSlotMode>;
};

export type WorkflowGenerationTask = {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    progress: number;
    urls?: string[];
    error?: string;
};

export class WorkflowRequestError extends Error {
    status?: number;
    retryable: boolean;

    constructor(message: string, status?: number, retryable = false) {
        super(message);
        this.name = "WorkflowRequestError";
        this.status = status;
        this.retryable = retryable;
    }
}

function isRetryableWorkflowStatus(status?: number) {
    return status === undefined || status === 408 || status === 429 || status >= 500;
}

export function isRetryableWorkflowError(error: unknown) {
    if (error instanceof WorkflowRequestError) return error.retryable;
    if (error instanceof TypeError) return true;
    return error instanceof Error && /(?:失败|status)[：:\s]*(408|429|5\d\d)\b/i.test(error.message);
}

async function workflowRequest<T>(path: string, token: string, signal?: AbortSignal, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new WorkflowRequestError("工作流网络请求失败", undefined, true);
    }
    let result: { code: number; data: T; msg: string };
    try {
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid response");
        result = payload as typeof result;
    } catch {
        throw new WorkflowRequestError("工作流响应格式无效", response.status, isRetryableWorkflowStatus(response.status));
    }
    if (!response.ok || result.code !== 0) {
        throw new WorkflowRequestError(result.msg || "工作流请求失败", response.status, !response.ok && isRetryableWorkflowStatus(response.status));
    }
    return result.data;
}

export function submitWorkflowTask(token: string, input: WorkflowRunInput, signal?: AbortSignal) {
    return workflowRequest<WorkflowGenerationTask>("/api/v1/workflow-tasks", token, signal, input);
}

export function getWorkflowTask(token: string, id: string, signal?: AbortSignal) {
    return workflowRequest<WorkflowGenerationTask>(`/api/v1/workflow-tasks/${encodeURIComponent(id)}`, token, signal);
}

export function comfyOutputStorageKey(url: string) {
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/outputs\/([a-f\d]{16,64})$/i);
        if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "8189" || !match) return "";
        return `comfy:${match[1]}`;
    } catch {
        return "";
    }
}

export async function runWorkflowTask(token: string, input: WorkflowRunInput, signal?: AbortSignal, onUpdate?: (task: WorkflowGenerationTask) => void) {
    let task = await submitWorkflowTask(token, input, signal);
    onUpdate?.(task);
    while (task.status === "queued" || task.status === "running") {
        await new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            const onAbort = () => { clearTimeout(timer); reject(new DOMException("已停止等待", "AbortError")); };
            timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 5000);
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
        });
        task = await getWorkflowTask(token, task.id, signal);
        onUpdate?.(task);
    }
    if (task.status === "failed") throw new WorkflowRequestError(task.error || "工作流运行失败");
    return task;
}

export async function workflowMediaSource(url: string): Promise<string> {
    if (/^https:\/\//i.test(url) || url.startsWith("data:")) return url;
    if (!url) throw new Error("工作流素材地址为空");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取工作流素材失败：${response.status}`);
    const blob = await response.blob();
    return readFileAsDataUrl(new File([blob], "workflow-media", { type: blob.type }), "读取素材失败：workflow-media");
}
