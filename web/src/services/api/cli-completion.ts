import { localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CLIHelperResult } from "@/lib/provider";

export class CLICompletionRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "CLICompletionRequestError";
    }
}

export async function requestControlledCLICompletion(config: AiConfig, prompt: string, signal?: AbortSignal) {
    const channel = localChannelForActiveModel(config);
    const token = useUserStore.getState().token;
    if (!channel?.id || !["codex", "gemini-cli"].includes(channel.protocol) || !token) throw new CLICompletionRequestError("受控 CLI 渠道不可用", 400);

    const started = await requestCLIAction(`/api/v1/providers/${encodeURIComponent(channel.id)}/cli/completions`, token, { model: config.model, prompt }, signal);
    if (!started.taskId || started.taskStatus !== "running") throw new CLICompletionRequestError(started.message || "受控 CLI 调用未启动", 400);
    try {
        for (;;) {
            await waitForCLICompletion(2500, signal);
            const result = await requestCLIAction(`/api/v1/providers/${encodeURIComponent(channel.id)}/cli/model-probe/${encodeURIComponent(started.taskId)}/status`, token, {}, signal);
            if (result.taskStatus === "running") continue;
            if (result.taskStatus === "succeeded" && result.output) return result.output;
            throw new CLICompletionRequestError(result.message || "受控 CLI 调用失败", 502);
        }
    } catch (error) {
        if (signal?.aborted) {
            void requestCLIAction(`/api/v1/providers/${encodeURIComponent(channel.id)}/cli/model-probe/${encodeURIComponent(started.taskId)}/cancel`, token, {}).catch(() => undefined);
            const aborted = new Error("调用已取消");
            aborted.name = "AbortError";
            throw aborted;
        }
        throw error;
    }
}

async function requestCLIAction(url: string, token: string, body: unknown, signal?: AbortSignal) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const envelope = (await response.json().catch(() => ({}))) as { code?: number; data?: CLIHelperResult; msg?: string };
    if (!response.ok || envelope.code !== 0 || !envelope.data) throw new CLICompletionRequestError(envelope.msg || "受控 CLI 接口请求失败", response.status);
    return envelope.data;
}

function waitForCLICompletion(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const abort = () => {
            globalThis.clearTimeout(timer);
            const error = new Error("调用已取消");
            error.name = "AbortError";
            reject(error);
        };
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
