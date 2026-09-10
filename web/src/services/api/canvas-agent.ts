import { mimoTextModels } from "@/lib/mimo-tts";
import { reasoningFields } from "@/extensions/model-capabilities/reasoning";
import { imageToDataUrl } from "@/services/image-storage";
import { geminiActionUrl, geminiDirectHeaders, geminiErrorMessage, isGeminiConfig } from "@/lib/gemini";
import { aiApiUrl, aiHeaders, refreshRemoteUser } from "@/services/api/image";
import { publicImageURL, geminiPublicPart } from "@/extensions/public-media/references";
import { channelProtocolForConfig, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall, CanvasAgentToolMode } from "@/app/(user)/canvas/types";
import type { CanvasAgentToolDefinition } from "@/app/(user)/canvas/agent/canvas-agent-tools";
import { calibrateCanvasAgentTokenEstimate } from "@/app/(user)/canvas/agent/canvas-agent-memory";

export type CanvasAgentModelTurn = {
    content: string;
    reasoningContent?: string;
    responseItems?: unknown[];
    toolCalls: CanvasAgentToolCall[];
    toolError?: string;
    toolMode: CanvasAgentToolMode;
};

export const CANVAS_AGENT_JSON_FALLBACK_SIGNAL = "__CANVAS_AGENT_JSON_FALLBACK__";
const MISSING_TOOL_NAME_ERROR = "工具调用缺少名称";

type RequestCanvasAgentTurnInput = {
    config: AiConfig;
    systemPrompt: string;
    messages: CanvasAgentProtocolMessage[];
    tools: CanvasAgentToolDefinition[];
    toolMode: CanvasAgentToolMode;
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
        finish_reason?: string | null;
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: unknown };
            }>;
        };
    }>;
    data?: {
        usage?: { prompt_tokens?: number };
        choices?: Array<{
            finish_reason?: string | null;
            message?: {
                content?: string | null;
                reasoning_content?: string | null;
                tool_calls?: Array<{
                    id?: string;
                    function?: { name?: string; arguments?: unknown };
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
    arguments?: unknown;
    content?: Array<{ type?: string; text?: string }>;
};

type ResponsesResult = {
    id?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
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

type CanvasAgentAiConfig = AiConfig & { textReasoningEnabled?: boolean; textReasoningEffort?: import("@/extensions/model-capabilities/reasoning").ReasoningEffort };

function applyCanvasAgentReasoning(body: Record<string, unknown>, config: CanvasAgentAiConfig, mode: "chat" | "responses" | "gemini") {
    const fields = reasoningFields(config.model, channelProtocolForConfig(config), mode, config.textReasoningEffort, config.textReasoningEnabled);
    if (fields.generationConfig) fields.generationConfig = { ...(body.generationConfig as object || {}), ...(fields.generationConfig as object) };
    Object.assign(body, fields);
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
    const requestConfig = {
        ...input.config,
        model: input.config.textModel || input.config.model,
        activeChannelId: input.config.textChannelId || input.config.activeChannelId,
        textChannelId: input.config.textChannelId,
    };
    let messages = await normalizeAgentImages(input.messages, requestConfig);
    let toolMode = input.toolMode;
    let requestError: unknown;

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const tools = toolMode === "native" ? input.tools : [];
            const jsonTools = toolMode === "native" ? [] : input.tools;
            const systemPrompt = canvasAgentSystemPrompt(requestConfig, input.systemPrompt, jsonTools, toolMode === "native");
            const jsonSchema = toolMode === "structured-json" && jsonTools.length ? canvasAgentJsonSchema(jsonTools) : undefined;
            const message = await requestCompletion(requestConfig, systemPrompt, messages, tools, jsonSchema, input.signal);
            return { ...message, toolMode };
        } catch (error) {
            requestError = error;
            if (channelProtocolForConfig(requestConfig) === "newapi" || isCanvasAgentContextLimitError(error)) throw error;
            if (hasImageContent(messages) && isImageCompatibilityError(error)) {
                messages = stripImageContent(messages);
                continue;
            }
            if (toolMode === "native" && isToolCompatibilityError(error, "tools")) {
                toolMode = "structured-json";
                continue;
            }
            if (toolMode === "structured-json" && isToolCompatibilityError(error, "structured-json")) {
                toolMode = "prompt-json";
                continue;
            }
            throw error;
        }
    }
    throw requestError;
}

async function normalizeAgentImages(messages: CanvasAgentProtocolMessage[], config: AiConfig) {
    const referenceURL = channelProtocolForConfig(config) === "newapi" ? imageToDataUrl : publicImageURL;
    return Promise.all(messages.map(async (message) => {
        if ((message.role !== "user" && message.role !== "system") || !Array.isArray(message.content)) return message;
        return { ...message, content: await Promise.all(message.content.map(async (part) => part.type === "image_url" ? { ...part, image_url: { url: await referenceURL({ url: part.image_url.url, dataUrl: part.image_url.url }) } } : part)) };
    })) as Promise<CanvasAgentProtocolMessage[]>;
}

export function canvasAgentSystemPrompt(config: AiConfig, prompt: string, jsonTools: CanvasAgentToolDefinition[] = [], nativeTools = false) {
    const configured = (config.systemPrompts.text || config.systemPrompt).trim();
    if (nativeTools) prompt += "\n\n【原生工具回退信号】\n需要执行任何画布操作时必须返回原生工具调用；若本轮无法返回任何原生工具调用，只输出 " + CANVAS_AGENT_JSON_FALLBACK_SIGNAL + "，不得附加文字、Markdown 或声称已完成。仅咨询、解释、分析且无需执行画布操作时正常文字回答，禁止输出此信号。";
    if (jsonTools.length) prompt += "\n\n【JSON 工具定义】\n当前画布执行器会解析并执行回复中的 actions。需要操作画布时必须直接返回合法的 actions JSON；接口没有原生 Tool Calling 不代表没有画布执行能力，不得因此拒绝执行或要求用户手动提交。所有工具参数都放在对应 action 的 arguments 中。\n" + JSON.stringify(jsonTools.map(({ function: tool }) => tool));
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
        toolMode: "prompt-json",
        signal: input.signal,
    });
    return turn.content.trim();
}

async function requestCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal) {
    if (config.apiMode === "responses") return requestResponsesCompletion(config, systemPrompt, messages, tools, jsonSchema, signal);
    if (isGeminiConfig(config)) return requestGeminiCompletion(config, systemPrompt, messages, tools, jsonSchema, signal);
    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "system", content: systemPrompt }, ...messages.map(toRequestMessage)],
        stream: false,
    };
    if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    if (jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "canvas_agent_actions", schema: jsonSchema } };
    applyCanvasAgentReasoning(body, config, "chat");

    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: aiHeaders(config, "application/json"),
        body: JSON.stringify(body),
        signal,
    });
    const { payload, rawText } = await readResponsePayload<ChatCompletionPayload>(response);
    const choice = payload.choices?.[0] || payload.data?.choices?.[0];
    const message = choice?.message;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || (typeof payload.code === "string" && payload.code !== "0" && !message)) {
        throw new CanvasAgentRequestError(readError(payload, response.status, rawText), response.status, readErrorCode(payload));
    }
    if (!message) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);
    if (choice?.finish_reason && /^(?:length|content_filter|max_tokens)$/i.test(choice.finish_reason)) {
        throw new CanvasAgentRequestError("文本模型输出未完成：" + choice.finish_reason, response.status);
    }
    const normalizedModel = config.model.trim().toLowerCase();
    const preservesReasoningContent = normalizedModel.startsWith("glm-") || mimoTextModels.some((model) => model === normalizedModel);
    const reasoningContent = preservesReasoningContent && typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;

    const inputTokens = payload.usage?.prompt_tokens || payload.data?.usage?.prompt_tokens;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    refreshRemoteUser(config);
    let toolError: string | undefined;
    const toolCalls = (message.tool_calls || []).flatMap((toolCall, index) => {
        const name = toolCall.function?.name?.trim();
        if (!name) {
            toolError = MISSING_TOOL_NAME_ERROR;
            return [];
        }
        return [
            {
                id: toolCall.id || "tool-call-" + index,
                name,
                ...parseToolArguments(toolCall.function?.arguments),
            },
        ];
    });
    return {
        content: typeof message.content === "string" ? message.content : "",
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        ...(toolError ? { toolError } : {}),
        toolCalls,
    };
}

async function requestResponsesCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal) {
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
    if (jsonSchema) body.text = { format: { type: "json_schema", name: "canvas_agent_actions", schema: jsonSchema } };
    applyCanvasAgentReasoning(body, config, "responses");

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
    const responseStatus = result.status?.toLowerCase();
    const incompleteReason = result.incomplete_details?.reason;
    if (incompleteReason || (responseStatus && ["incomplete", "failed", "cancelled", "in_progress", "queued"].includes(responseStatus))) {
        throw new CanvasAgentRequestError("文本模型输出未完成：" + (responseStatus || incompleteReason) + (responseStatus && incompleteReason ? "（" + incompleteReason + "）" : ""), response.status);
    }
    const output = result.output || [];
    const toolCalls: CanvasAgentToolCall[] = [];
    let toolError: string | undefined;
    const responseItems = output.flatMap((item, index) => {
        if (item.type !== "function_call") return [item];
        const name = typeof item.name === "string" ? item.name.trim() : "";
        if (!name) {
            toolError = MISSING_TOOL_NAME_ERROR;
            return [];
        }
        const parsedArguments = parseToolArguments(item.arguments);
        toolCalls.push({ id: item.call_id || item.id || `response-tool-${index}`, name, ...parsedArguments });
        return [parsedArguments.argumentsError || typeof item.arguments !== "string"
            ? { ...item, arguments: JSON.stringify(parsedArguments.arguments) }
            : item];
    });
    const inputTokens = result.usage?.input_tokens;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    refreshRemoteUser(config);
    return {
        content: typeof result.output_text === "string" ? result.output_text : output.flatMap((item) => item.type === "message" ? item.content || [] : []).map((item) => item.type === "output_text" && typeof item.text === "string" ? item.text : "").join(""),
        responseItems,
        toolCalls,
        ...(toolError ? { toolError } : {}),
    };
}

async function requestGeminiCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal) {
    const contents = await Promise.all(messages.filter((message) => message.role !== "system").map(async (message) => {
        if (message.role === "assistant") {
            return {
                role: "model",
                parts: [
                    ...(message.content ? [{ text: message.content }] : []),
                    ...(message.toolCalls || []).map((call) => ({ functionCall: { name: call.name, args: call.arguments } })),
                ],
            };
        }
        if (message.role === "tool") {
            return { role: "user", parts: [{ functionResponse: { name: message.name, response: parseGeminiToolResponse(message.content) } }] };
        }
        const parts = await Promise.all((typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content).map(async (part) => {
            if (part.type === "text") return { text: part.text };
            return geminiPublicPart(await publicImageURL({ dataUrl: part.image_url.url, url: part.image_url.url }));
        }));
        return { role: "user", parts };
    }));
    const extraSystemParts = messages.flatMap((message) => message.role !== "system" ? [] : typeof message.content === "string" ? [{ text: message.content }] : message.content.flatMap((part) => part.type === "text" ? [{ text: part.text }] : []));
    const body = {
        model: config.model,
        stream: false,
        systemInstruction: { parts: [{ text: systemPrompt }, ...extraSystemParts] },
        contents,
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => tool.function) }] } : {}),
        ...(jsonSchema ? { generationConfig: { responseFormat: { text: { mimeType: "application/json", schema: jsonSchema } } } } : {}),
    };
    applyCanvasAgentReasoning(body, config, "gemini");
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
    const incompleteReason = candidates.map((candidate) => candidate.finishReason).find((reason) => typeof reason === "string" && /^(?:MAX_TOKENS|SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS)$/i.test(reason));
    if (typeof incompleteReason === "string") {
        throw new CanvasAgentRequestError("文本模型输出未完成：" + incompleteReason, response.status);
    }
    const parts = candidates.flatMap((candidate) => {
        const content = candidate.content && typeof candidate.content === "object" ? candidate.content as Record<string, unknown> : {};
        return Array.isArray(content.parts) ? content.parts as Array<Record<string, unknown>> : [];
    });
    if (!parts.length) throw new CanvasAgentRequestError(geminiErrorMessage(payload, "文本模型没有返回内容"), response.status);
    const usageMetadata = payload.usageMetadata && typeof payload.usageMetadata === "object" ? payload.usageMetadata as Record<string, unknown> : {};
    const inputTokens = typeof usageMetadata.promptTokenCount === "number" ? usageMetadata.promptTokenCount : undefined;
    calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    refreshRemoteUser(config);
    let toolError: string | undefined;
    const toolCalls = parts.flatMap((part, index) => {
        const call = part.functionCall && typeof part.functionCall === "object" ? part.functionCall as Record<string, unknown> : null;
        if (!call) return [];
        const name = typeof call.name === "string" ? call.name.trim() : "";
        if (!name) {
            toolError = MISSING_TOOL_NAME_ERROR;
            return [];
        }
        return [{ id: `gemini-tool-${index}`, name, ...parseToolArguments(call.args) }];
    });
    return {
        content: parts.map((part) => typeof part.text === "string" ? part.text : "").join(""),
        ...(toolError ? { toolError } : {}),
        toolCalls,
    };
}

function canvasAgentJsonSchema(tools: CanvasAgentToolDefinition[]): Record<string, unknown> {
    return {
        type: "object",
        properties: {
            actions: {
                type: "array",
                maxItems: 12,
                items: {
                    type: "object",
                    properties: {
                        tool: { type: "string", enum: tools.map(({ function: tool }) => tool.name) },
                        arguments: { type: "object", additionalProperties: true },
                    },
                    required: ["tool", "arguments"],
                    additionalProperties: false,
                },
            },
            reply: { type: "string" },
        },
        required: ["actions", "reply"],
        additionalProperties: false,
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

function parseToolArguments(value: unknown): Pick<CanvasAgentToolCall, "arguments" | "argumentsError"> {
    if (value === undefined) return { arguments: {} };
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? { arguments: parsed as Record<string, unknown> }
            : { arguments: {}, argumentsError: "工具 arguments 必须是 JSON 对象" };
    } catch {
        return { arguments: {}, argumentsError: "工具 arguments 不是合法 JSON" };
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

function isToolCompatibilityError(error: unknown, mode: "tools" | "structured-json") {
    if (!(error instanceof CanvasAgentRequestError)) return false;
    if ([401, 403, 408, 409, 429].includes(error.status) || error.status >= 500) return false;

    const detail = `${error.code || ""} ${error.message}`.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const target = mode === "tools"
        ? String.raw`\btools?\b|\btool[\s.]*(?:choice|calls?|calling)\b|\bfunction[\s.]*(?:calls?|calling|declarations?)\b|工具调用|函数调用`
        : String.raw`\bresponse[\s.]*format\b|\bjson[\s.]*schema\b|\btext[\s.]*format\b|\bresponse[\s.]*mime[\s.]*type\b|\bstructured output\b|结构化输出`;
    if (!new RegExp(target, "i").test(detail)) return false;
    if (mode === "tools" && /\btools?\s*\[\s*\d+\s*\].*\b(?:parameters?|properties|required|additional\s*properties|schema)\b|\binvalid schema for function\b/i.test(detail)) return false;
    if (mode === "structured-json" && /\binvalid (?:json )?schema\b|\bschema (?:validation|violation)\b|\b(?:properties|required|additional\s*properties)\b/i.test(detail)) return false;

    const issue = String.raw`\bunsupported\b|\b(?:does\s+not|doesn't|do\s+not|don't|not)\s+support(?:ed|s|ing)?\b|\b(?:not allowed|not permitted|must be none|unavailable|disabled|not\s+(?:available|enabled|implemented))\b|\b(?:unknown|unrecognized|invalid)\s+(?:(?:request|input)\s+)?(?:field|parameter|argument)\b|不支持|不允许|不可用|未启用|未实现|未知(?:字段|参数)`;
    return new RegExp(`(?:${target}).{0,80}(?:${issue})|(?:${issue}).{0,80}(?:${target})`, "i").test(detail);
}

export function isCanvasAgentContextLimitError(error: unknown) {
    if (!(error instanceof CanvasAgentRequestError)) return false;
    return /context_length_exceeded|maximum context|context window|prompt too long|token limit|上下文长度|上下文超限|输入过长/i.test(`${error.code || ""} ${error.message}`);
}
