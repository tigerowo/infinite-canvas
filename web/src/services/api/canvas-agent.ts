import { mimoTextModels } from "@/lib/mimo-tts";
import { dataUrlToGeminiInlineData, geminiActionUrl, geminiDirectHeaders, geminiErrorMessage, isGeminiConfig } from "@/lib/gemini";
import { aiApiUrl, aiHeaders, refreshRemoteUser } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { channelProtocolForConfig, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { requestControlledCLICompletion } from "@/services/api/cli-completion";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall } from "@/app/(user)/canvas/types";
import type { CanvasAgentToolDefinition } from "@/app/(user)/canvas/agent/canvas-agent-tools";
import { calibrateCanvasAgentTokenEstimate } from "@/app/(user)/canvas/agent/canvas-agent-memory";

export type CanvasAgentModelTurn = {
    content: string;
    reasoningContent?: string;
    responseItems?: unknown[];
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

type AiErrorPayload = {
    code?: number | string;
    msg?: string;
    error?: { code?: string; type?: string; message?: string };
};

type ChatCompletionPayload = AiErrorPayload & {
    usage?: { prompt_tokens?: number };
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
        usage?: { prompt_tokens?: number };
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

type ResponsesOutputItem = Record<string, unknown> & {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
};

type ResponsesResult = {
    id?: string;
    output_text?: string;
    output?: ResponsesOutputItem[];
    usage?: { input_tokens?: number };
};

type ResponsesPayload = AiErrorPayload & ResponsesResult & { data?: ResponsesResult };

class CanvasAgentRequestError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "CanvasAgentRequestError";
        this.status = status;
        this.code = code;
    }
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
    const requestConfig = {
        ...input.config,
        model: input.config.textModel || input.config.model,
        activeChannelId: input.config.textChannelId || input.config.activeChannelId,
        textChannelId: input.config.textChannelId,
    };
    const systemPrompt = canvasAgentSystemPrompt(requestConfig, input.systemPrompt);
    if (["codex", "gemini-cli", "gemini-official-cli", "chatgpt-subscription-proxy", "antigravity-subscription-proxy"].includes(channelProtocolForConfig(requestConfig))) {
        const content = await requestControlledCLICompletion(requestConfig, buildControlledCLIPrompt(systemPrompt, input.messages, input.allowTools ? input.tools : []), input.signal);
        return { content, toolCalls: [], usedJsonFallback: true };
    }
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
            if (isCanvasAgentContextLimitError(error)) throw error;
            if (hasImageContent(messages) && isImageCompatibilityError(error)) {
                messages = stripImageContent(messages);
                continue;
            }
            if (requestConfig.apiMode !== "responses" && tools.length && isToolCompatibilityError(error)) {
                tools = [];
                usedJsonFallback = true;
                continue;
            }
            throw error;
        }
    }
    throw requestError;
}

function buildControlledCLIPrompt(systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[]) {
    const toolGuide = tools.length
        ? `可用画布工具（只能通过 JSON actions 调用）：\n${JSON.stringify(tools.map((tool) => tool.function))}\n返回格式：{"reply":"给用户的回复","actions":[{"name":"工具名","arguments":{}}]}`
        : "直接返回给用户的文本，不要调用工具。";
    const transcript = messages
        .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (part.type === "text" ? part.text : "[图片引用]")).join("\n") : ""}`)
        .join("\n\n");
    const prefix = `${systemPrompt}\n\n${toolGuide}`.slice(0, 3000);
    return `${prefix}\n\n对话记录：\n${transcript.slice(-3000)}`;
}

export function canvasAgentSystemPrompt(config: AiConfig, prompt: string) {
    const configured = (config.systemPrompts.text || config.systemPrompt).trim();
    return configured ? configured + "\n\n" + prompt : prompt;
}

export async function requestCanvasAgentCheckpoint(input: {
    config: AiConfig;
    previousCheckpoint?: string;
    messages: unknown;
    signal?: AbortSignal;
}) {
    const turn = await requestCanvasAgentTurn({
        config: input.config,
        systemPrompt: "你负责生成画布 Agent 的长期对话检查点。仅保留用户长期目标与偏好、已确认方案、不可改变要求、否决方向、未解决事项、重要节点 ID 的职责线索，以及当前 Skill 和阶段线索。节点是否存在、节点正文、任务状态必须以之后注入的真实画布和工具结果为准；不得声称工具或媒体已成功，不得保存 Base64。直接输出检查点正文，控制在 16000 Token 以内。",
        messages: [{
            role: "user",
            content: `【旧检查点】\n${input.previousCheckpoint || "无"}\n\n【本次归档的完整旧轮次】\n${JSON.stringify(input.messages)}`,
        }],
        tools: [],
        allowTools: false,
        signal: input.signal,
    });
    return turn.content.trim();
}

async function requestCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], signal?: AbortSignal) {
    if (config.apiMode === "responses") return requestResponsesCompletion(config, systemPrompt, messages, tools, signal);
    if (isGeminiConfig(config)) return requestGeminiCompletion(config, systemPrompt, messages, tools, signal);
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
    const { payload, rawText } = await readResponsePayload<ChatCompletionPayload>(response);
    const message = payload.choices?.[0]?.message || payload.data?.choices?.[0]?.message;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || (typeof payload.code === "string" && payload.code !== "0" && !message)) {
        throw new CanvasAgentRequestError(readError(payload, response.status, rawText), response.status, readErrorCode(payload));
    }
    if (!message) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);
    const normalizedModel = config.model.trim().toLowerCase();
    const preservesReasoningContent = normalizedModel.startsWith("glm-") || mimoTextModels.some((model) => model === normalizedModel);
    const reasoningContent = preservesReasoningContent && typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;

    const inputTokens = payload.usage?.prompt_tokens || payload.data?.usage?.prompt_tokens;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
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

async function requestResponsesCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], signal?: AbortSignal) {
    const body: Record<string, unknown> = {
        model: config.model,
        instructions: systemPrompt,
        input: messages.flatMap(toResponsesInput),
        store: false,
        include: ["reasoning.encrypted_content"],
    };
    if (tools.length) {
        body.tools = tools.map((tool) => ({ type: "function", ...tool.function }));
        body.tool_choice = "auto";
    }

    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: aiHeaders(config, "application/json"),
        body: JSON.stringify(body),
        signal,
    });
    const { payload, rawText } = await readResponsePayload<ResponsesPayload>(response);
    const result = payload.output ? payload : payload.data;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || (typeof payload.code === "string" && payload.code !== "0" && !result)) {
        throw new CanvasAgentRequestError(readError(payload, response.status, rawText), response.status, readErrorCode(payload));
    }
    if (!result) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);

    const output = result.output || [];
    const inputTokens = result.usage?.input_tokens;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    refreshRemoteUser(config);
    return {
        content: typeof result.output_text === "string" ? result.output_text : output.flatMap((item) => item.type === "message" ? item.content || [] : []).map((item) => item.type === "output_text" && typeof item.text === "string" ? item.text : "").join(""),
        responseItems: output,
        toolCalls: output.flatMap((item, index) => item.type === "function_call" && typeof item.name === "string" ? [{ id: item.call_id || item.id || `response-tool-${index}`, name: item.name, arguments: parseToolArguments(item.arguments) }] : []),
    };
}

async function requestGeminiCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], signal?: AbortSignal) {
    const contents = await Promise.all(
        messages
            .filter((message) => message.role !== "system")
            .map(async (message) => {
                if (message.role === "assistant") {
                    return {
                        role: "model",
                        parts: [...(message.content ? [{ text: message.content }] : []), ...(message.toolCalls || []).map((call) => ({ functionCall: { name: call.name, args: call.arguments } }))],
                    };
                }
                if (message.role === "tool") {
                    return { role: "user", parts: [{ functionResponse: { name: message.name, response: parseGeminiToolResponse(message.content) } }] };
                }
                const parts = await Promise.all(
                    (typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content).map(async (part) => {
                        if (part.type === "text") return { text: part.text };
                        return dataUrlToGeminiInlineData(await imageToDataUrl({ dataUrl: part.image_url.url, url: part.image_url.url }));
                    }),
                );
                return { role: "user", parts };
            }),
    );
    const extraSystemParts = messages
        .filter((message) => message.role === "system")
        .flatMap((message) => (typeof message.content === "string" ? [{ text: message.content }] : Array.isArray(message.content) ? message.content.flatMap((part) => (part.type === "text" ? [{ text: part.text }] : [])) : []));
    const body = {
        model: config.model,
        stream: false,
        systemInstruction: { parts: [{ text: systemPrompt }, ...extraSystemParts] },
        contents,
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => tool.function) }] } : {}),
    };
    const proxy = Boolean(aiApiUrl(config, "/chat/completions").startsWith("/api/"));
    const channel = localChannelForActiveModel(config);
    const { model: _model, stream: _stream, ...nativeBody } = body;
    const response = await fetch(proxy ? aiApiUrl(config, "/chat/completions") : geminiActionUrl(channel?.baseUrl || config.baseUrl, config.model, "generateContent"), {
        method: "POST",
        headers: proxy ? aiHeaders(config, "application/json") : geminiDirectHeaders(config),
        body: JSON.stringify(proxy ? body : nativeBody),
        signal,
    });
    const { payload, rawText } = await readResponsePayload<Record<string, unknown>>(response);
    if (!response.ok) throw new CanvasAgentRequestError(geminiErrorMessage(payload, rawText || "文本模型请求失败"), response.status, geminiErrorCode(payload));
    const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : [];
    const parts = candidates.flatMap((candidate) => {
        const content = candidate.content && typeof candidate.content === "object" ? (candidate.content as Record<string, unknown>) : {};
        return Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    });
    if (!parts.length) throw new CanvasAgentRequestError(geminiErrorMessage(payload, "文本模型没有返回内容"), response.status);
    const usageMetadata = payload.usageMetadata && typeof payload.usageMetadata === "object" ? payload.usageMetadata as Record<string, unknown> : {};
    const inputTokens = typeof usageMetadata.promptTokenCount === "number" ? usageMetadata.promptTokenCount : undefined;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    refreshRemoteUser(config);
    return {
        content: parts.map((part) => (typeof part.text === "string" ? part.text : "")).join(""),
        toolCalls: parts.flatMap((part, index) => {
            const call = part.functionCall && typeof part.functionCall === "object" ? (part.functionCall as Record<string, unknown>) : null;
            const name = typeof call?.name === "string" ? call.name.trim() : "";
            return name ? [{ id: `gemini-tool-${index}`, name, arguments: call?.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {} }] : [];
        }),
    };
}

function parseGeminiToolResponse(value: string) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : { result: parsed };
    } catch {
        return { result: value };
    }
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

function toResponsesInput(message: CanvasAgentProtocolMessage): unknown[] {
    if (message.role === "assistant") {
        if (message.responseItems?.length) return message.responseItems;
        return [
            ...(message.content ? [{ role: "assistant", content: message.content }] : []),
            ...(message.toolCalls || []).map((toolCall) => ({ type: "function_call", call_id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) })),
        ];
    }
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    return [{
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url }),
    }];
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

function readError(payload: AiErrorPayload, status: number, rawText = "") {
    return payload.error?.message || payload.msg || rawText || (status ? "文本模型请求失败：" + status : "文本模型请求失败");
}

function readErrorCode(payload: AiErrorPayload) {
    return payload.error?.code || payload.error?.type || (typeof payload.code === "string" ? payload.code : undefined);
}

function geminiErrorCode(payload: Record<string, unknown>) {
    const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    return typeof error.code === "string" ? error.code : typeof error.status === "string" ? error.status : undefined;
}

async function readResponsePayload<T extends object>(response: Response) {
    const rawText = await response.text();
    try {
        return { payload: (rawText ? JSON.parse(rawText) : {}) as T, rawText };
    } catch {
        return { payload: {} as T, rawText };
    }
}

export function canvasAgentTokenCalibrationKey(config: AiConfig) {
    return `${config.apiMode}:${isGeminiConfig(config) ? "gemini" : "openai"}:${config.baseUrl}:${config.model}`;
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

export function isCanvasAgentContextLimitError(error: unknown) {
    if (!(error instanceof CanvasAgentRequestError)) return false;
    return /context_length_exceeded|maximum context|context window|prompt too long|token limit|上下文长度|上下文超限|输入过长/i.test(`${error.code || ""} ${error.message}`);
}
