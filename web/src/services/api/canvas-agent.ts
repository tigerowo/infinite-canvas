import { mimoTextModels } from "@/lib/mimo-tts";
import { aiApiUrl, aiHeaders, refreshRemoteUser } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall } from "@/app/(user)/canvas/types";
import type { CanvasAgentToolDefinition } from "@/app/(user)/canvas/agent/canvas-agent-tools";

export type CanvasAgentModelTurn = {
    content: string;
    reasoningContent?: string;
    toolCalls: CanvasAgentToolCall[];
    usedJsonFallback: boolean;
};

type RequestCanvasAgentTurnInput = {
    config: AiConfig;
    systemPrompt: string;
    messages: CanvasAgentProtocolMessage[];
    tools: CanvasAgentToolDefinition[];
    allowTools: boolean;
    signal?: AbortSignal;
};

type ChatCompletionPayload = {
    code?: number;
    msg?: string;
    error?: { message?: string };
    choices?: Array<{
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
            }>;
        };
    }>;
    data?: {
        choices?: Array<{
            message?: {
                content?: string | null;
                reasoning_content?: string | null;
                tool_calls?: Array<{
                    id?: string;
                    function?: { name?: string; arguments?: string | Record<string, unknown> };
                }>;
            };
        }>;
    };
};

class CanvasAgentRequestError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "CanvasAgentRequestError";
        this.status = status;
    }
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
    const requestConfig = {
        ...input.config,
        model: input.config.textModel || input.config.model,
        activeChannelId: input.config.textChannelId || input.config.activeChannelId,
        textChannelId: input.config.textChannelId,
    };
    const configuredSystemPrompt = (requestConfig.systemPrompts.text || requestConfig.systemPrompt).trim();
    const systemPrompt = configuredSystemPrompt ? configuredSystemPrompt + "\n\n" + input.systemPrompt : input.systemPrompt;
    let messages = input.messages;
    let tools = input.allowTools ? input.tools : [];
    let usedJsonFallback = !input.allowTools;
    let requestError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const message = await requestCompletion(requestConfig, systemPrompt, messages, tools, input.signal);
            return { ...message, usedJsonFallback };
        } catch (error) {
            requestError = error;
            if (hasImageContent(messages) && isImageCompatibilityError(error)) {
                messages = stripImageContent(messages);
                continue;
            }
            if (tools.length && isToolCompatibilityError(error)) {
                tools = [];
                usedJsonFallback = true;
                continue;
            }
            throw error;
        }
    }
    throw requestError;
}

async function requestCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], signal?: AbortSignal) {
    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "system", content: systemPrompt }, ...messages.map(toRequestMessage)],
        stream: false,
    };
    if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }

    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: aiHeaders(config, "application/json"),
        body: JSON.stringify(body),
        signal,
    });
    const payload = (await response.json().catch(() => ({}))) as ChatCompletionPayload;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
        throw new CanvasAgentRequestError(readError(payload, response.status), response.status);
    }
    const message = payload.choices?.[0]?.message || payload.data?.choices?.[0]?.message;
    if (!message) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);
    const normalizedModel = config.model.trim().toLowerCase();
    const preservesReasoningContent = normalizedModel.startsWith("glm-") || mimoTextModels.some((model) => model === normalizedModel);
    const reasoningContent = preservesReasoningContent && typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;

    refreshRemoteUser(config);
    return {
        content: typeof message.content === "string" ? message.content : "",
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        toolCalls: (message.tool_calls || []).flatMap((toolCall, index) => {
            const name = toolCall.function?.name?.trim();
            if (!name) return [];
            return [
                {
                    id: toolCall.id || "tool-call-" + index,
                    name,
                    arguments: parseToolArguments(toolCall.function?.arguments),
                },
            ];
        }),
    };
}

function toRequestMessage(message: CanvasAgentProtocolMessage) {
    if (message.role === "assistant") {
        return {
            role: "assistant",
            content: message.content || null,
            ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
            ...(message.toolCalls?.length
                ? {
                      tool_calls: message.toolCalls.map((toolCall) => ({
                          id: toolCall.id,
                          type: "function",
                          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
                      })),
                  }
                : {}),
        };
    }
    if (message.role === "tool") {
        return {
            role: "tool",
            content: message.content,
            tool_call_id: message.toolCallId,
            name: message.name,
        };
    }
    return { role: message.role, content: message.content };
}

function parseToolArguments(value: string | Record<string, unknown> | undefined) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function readError(payload: ChatCompletionPayload, status: number) {
    return payload.error?.message || payload.msg || (status ? "文本模型请求失败：" + status : "文本模型请求失败");
}

function hasImageContent(messages: CanvasAgentProtocolMessage[]) {
    return messages.some((message) => (message.role === "user" || message.role === "system") && Array.isArray(message.content) && message.content.some((item) => item.type === "image_url"));
}

function stripImageContent(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message): CanvasAgentProtocolMessage => {
        if ((message.role === "user" || message.role === "system") && Array.isArray(message.content)) {
            return { role: message.role, content: message.content.filter((item) => item.type === "text") };
        }
        return message;
    });
}

function isImageCompatibilityError(error: unknown) {
    return error instanceof CanvasAgentRequestError && /image_url|image input|vision|multimodal|content.*array|unsupported.*image|不支持.*图片|图像输入/i.test(error.message);
}

function isToolCompatibilityError(error: unknown) {
    if (!(error instanceof CanvasAgentRequestError)) return false;
    return error.status === 400 || error.status === 422 || /tools?|tool_choice|function.?call|unknown field|unsupported|not support|不支持|未知字段/i.test(error.message);
}
