import { asRecord, firstString, normalizeDirectStatus, readDirectError, readPath, readString } from "./shared";
import type { DirectProtocolAdapter } from "./types";

export const autodlDirectProtocol: DirectProtocolAdapter = {
    rawAuthorization: true,
    pollPath: (taskId) => `/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`,
    pollURL(baseUrl, taskId) {
        const base = baseUrl.trim().replace(/\/+$/, "");
        return `${base}${this.pollPath(taskId)}`;
    },
    readTaskId: (payload) => readString(readPath(payload, "data.task_id")),
    readCreatedVideoStatus: (payload) => normalizeDirectStatus(readString(readPath(payload, "data.status"))),
    readError: readAutoDLError,
    readImagePoll: () => ({ urls: [], done: false, error: "AutoDL 当前工作流不支持图片生成" }),
    readAudioPoll: (payload) => readAutoDLResult(payload, "audio"),
    readVideoPoll(payload, pollId, model) {
        const result = readAutoDLResult(payload, "video");
        return {
            id: firstString(readPath(payload, "data.task_id"), pollId),
            task_id: firstString(readPath(payload, "data.task_id"), pollId),
            status: result.error ? "failed" : result.done ? "completed" : "processing",
            ...(result.url ? { video_url: result.url, url: result.url } : {}),
            ...(result.error ? { error: { message: result.error } } : {}),
            model,
        };
    },
};

function readAutoDLError(payload: unknown) {
    const code = readPath(payload, "code");
    const error = readDirectError(payload);
    if (error) return error;
    if (String(code).toLowerCase() !== "success") {
        return firstString(readPath(payload, "msg"), readPath(payload, "message"), readPath(payload, "data.message"), `AutoDL 请求失败：${code}`);
    }
    if (normalizeDirectStatus(readString(readPath(payload, "data.status"))) === "failed") {
        return firstString(readPath(payload, "data.message"), readPath(payload, "msg"), "AutoDL 任务失败");
    }
    return "";
}

function readAutoDLResult(payload: unknown, kind: "video" | "audio") {
    const results = readPath(payload, "data.results");
    const output = Array.isArray(results) ? results.map(asRecord).find((item) => item.type === kind && (!item.output_type || item.output_type === "output") && /^https?:\/\//i.test(readString(item.url))) : undefined;
    const url = readString(output?.url);
    const done = normalizeDirectStatus(readString(readPath(payload, "data.status"))) === "completed";
    const error = readAutoDLError(payload) || (done && !url ? `AutoDL 任务已完成但没有返回${kind === "audio" ? "音频" : "视频"}地址` : "");
    return { url, done, error };
}
