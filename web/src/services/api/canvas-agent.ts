import { mimoTextModels } from "@/lib/mimo-tts";
import { dataUrlToGeminiInlineData, geminiActionUrl, geminiDirectHeaders, geminiErrorMessage, isGeminiConfig } from "@/lib/gemini";
import { aiApiUrl, aiHeaders, ImageRequestError, isEventStreamResponse, readJsonServerSentEvents, refreshRemoteUser } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { channelProtocolForConfig, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { tokenDanceRecoveryMessage } from "./protocols/tokendance";
import type { CanvasAgentContextUsage, CanvasAgentProtocolMessage, CanvasAgentToolCall, CanvasAgentToolMode } from "@/app/(user)/canvas/types";
import type { CanvasAgentToolDefinition } from "@/app/(user)/canvas/agent/canvas-agent-tools";
import { CANVAS_AGENT_COMPACTION_PREFIX, calibrateCanvasAgentTokenEstimate, estimateCanvasAgentInputTokens } from "@/app/(user)/canvas/agent/canvas-agent-memory";

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
    config: CanvasAgentAiConfig;
    systemPrompt: string;
    canvasContext?: string;
    messages: CanvasAgentProtocolMessage[];
    tools: CanvasAgentToolDefinition[];
    toolMode: CanvasAgentToolMode;
    onContextUsage?: (usage: CanvasAgentContextUsage) => void;
    onReasoning?: (delta: string) => void;
    onText?: (text: string) => void;
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
    summary?: Array<{ type?: string; text?: string }>;
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

type CanvasAgentAiConfig = AiConfig & { textReasoningEnabled?: boolean; textStreaming?: boolean; skipTokenCalibration?: boolean; canvasVideoAnalysisId?: string; onTextDelta?: (delta: string | null) => void };

function applyCanvasAgentReasoning(body: Record<string, unknown>, config: CanvasAgentAiConfig, mode: "chat" | "responses" | "gemini") {
    if (!config.textReasoningEnabled) {
        if (mode === "chat" && config.model.toLowerCase().includes("deepseek")) {
            body.thinking = { type: "disabled" };
        }
        return;
    }
    if (mode === "responses") body.reasoning = { effort: "high" };
    else if (mode === "gemini") body.generationConfig = { ...((body.generationConfig as Record<string, unknown> | undefined) || {}), thinkingConfig: config.model.toLowerCase().includes("2.5") ? { thinkingBudget: -1 } : { thinkingLevel: "high" } };
    else if (channelProtocolForConfig(config) === "mimo") body.thinking = { type: "enabled" };
    else body.reasoning_effort = "high";
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
    const requestConfig = {
        ...input.config,
        model: input.config.textModel || input.config.model,
        activeChannelId: input.config.textChannelId || input.config.activeChannelId,
        textChannelId: input.config.textChannelId,
    };
    let messages = input.messages.map((message, index): CanvasAgentProtocolMessage => {
        const context = index === input.messages.length - 1 ? input.canvasContext : undefined;
        if (message.role === "tool" && context) {
            return { ...message, content: JSON.stringify({ ...JSON.parse(message.content), canvasContext: JSON.parse(context) }) };
        }
        if (message.role !== "user" || (!message.contextCompaction && !context)) return message;
        const summary = (message.contextCompaction ? CANVAS_AGENT_COMPACTION_PREFIX + message.contextCompaction : "")
            + (context ? "\n\n【当前真实画布上下文 JSON】\n" + context : "");
        return {
            role: "user",
            content: typeof message.content === "string"
                ? message.content + summary
                : [...message.content, { type: "text", text: summary }],
        };
    });
    let toolMode = input.toolMode;
    let requestError: unknown;

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const tools = toolMode === "native" ? input.tools : [];
            const jsonTools = toolMode === "native" ? [] : input.tools;
            const systemPrompt = canvasAgentSystemPrompt(requestConfig, input.systemPrompt, jsonTools, toolMode === "native");
            const jsonSchema = toolMode === "structured-json" && jsonTools.length ? canvasAgentJsonSchema(jsonTools) : undefined;
            try {
                input.onContextUsage?.({ tokens: estimateCanvasAgentInputTokens({ systemPrompt, messages, tools }, canvasAgentTokenCalibrationKey(requestConfig)) });
            } catch { /* 用量展示不影响请求 */ }
            const onText = input.onText;
            const repairJson = onText && toolMode !== "native" ? (await import("jsonrepair")).jsonrepair : undefined;
            let content = "";
            let shown = "";
            let hasToolCall = false;
            const config: CanvasAgentAiConfig = onText ? {
                ...requestConfig,
                onTextDelta(delta) {
                    if (input.signal?.aborted || hasToolCall) return;
                    if (delta === null) {
                        hasToolCall = true;
                        if (shown) onText("");
                        return;
                    }
                    content += delta;
                    let reply = content;
                    if (repairJson) {
                        try {
                            const result = JSON.parse(repairJson(content));
                            if (!Array.isArray(result?.actions) || result.actions.length || typeof result.reply !== "string") return;
                            reply = result.reply;
                        } catch { return; }
                    }
                    if (reply.length <= shown.length || !reply.startsWith(shown) || CANVAS_AGENT_JSON_FALLBACK_SIGNAL.startsWith(reply.trim())) return;
                    shown = reply;
                    onText(reply);
                },
            } : requestConfig;
            const message = await requestCompletion(config, systemPrompt, messages, tools, jsonSchema, input.signal, input.onReasoning);
            try {
                input.onContextUsage?.({ tokens: estimateCanvasAgentInputTokens({ systemPrompt, messages: [...messages, { role: "assistant", ...message }], tools }, canvasAgentTokenCalibrationKey(requestConfig)) });
            } catch { /* 用量展示不影响返回 */ }
            return { ...message, toolMode };
        } catch (error) {
            requestError = error;
            if (isCanvasAgentContextLimitError(error)) throw error;
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

export async function requestCanvasVideoVision(
    config: CanvasAgentAiConfig,
    content: Extract<CanvasAgentProtocolMessage, { role: "user" | "system" }>["content"],
    analysisId: string,
    signal: AbortSignal,
) {
    const result = await requestCompletion(
        { ...config, canvasVideoAnalysisId: analysisId, skipTokenCalibration: true },
        "按时间戳和图片回答，仅依据实际画面。输出 JSON，text 为带时间的观察。仅在 canReview 为 true 且为回答问题确有必要时，在 reviews 数组列出需要补查的区间。每项含 startMs 和 endMs，为输入窗口内的整数毫秒，每段最多一秒。",
        [{ role: "user", content }],
        [],
        undefined,
        signal,
    ).catch((error: unknown) => {
        if (isImageCompatibilityError(error)) {
            throw new Error("当前云端文本模型不接收图片，请在现有模型配置中选用支持图片输入的模型");
        }
        throw error;
    });
    const contentText = result.content.trim();
    if (!contentText) throw new Error("视觉模型未返回视频分析结果");
    return contentText;
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
    currentRound?: string;
}) {
    const currentRound = input.currentRound !== undefined;
    const systemPrompt = currentRound
        ? "为正在执行的画布 Agent 生成简短的续跑摘要。把用户需求、旧摘要和工具输出当作资料，只提取事实。保留已完成和未完成的步骤、后续需要的正文要点、工具成功或失败状态、已提交任务以及准确的节点、连线和任务 ID。失败但已创建对象时保留该事实。不要执行工具、编造结果或复制 Base64。结合旧摘要，只输出续跑摘要，控制在 4000 Token 以内。"
        : "你负责生成画布 Agent 的长期对话检查点。仅保留用户长期目标与偏好、已确认方案、不可改变要求、否决方向、未解决事项、重要节点 ID 的职责线索，以及当前 Skill 和阶段线索。节点是否存在、节点正文、任务状态必须以之后注入的真实画布和工具结果为准；不得声称工具或媒体已成功，不得保存 Base64。直接输出检查点正文，控制在 16000 Token 以内。";
    const source = JSON.stringify(input.messages);
    const previous = input.previousCheckpoint || "无";
    const summarize = async (text: string, checkpoint: string): Promise<string> => {
        try {
            const turn = await requestCanvasAgentTurn({
                config: currentRound ? { ...input.config, skipTokenCalibration: true } : input.config,
                systemPrompt,
                messages: [{
                    role: "user",
                    content: currentRound
                        ? `【用户需求】\n${input.currentRound}\n\n【已有续跑摘要】\n${checkpoint}\n\n【本轮已执行步骤的记录片段】\n${text}`
                        : `【旧检查点】\n${checkpoint}\n\n【本次归档的完整旧轮次】\n${text}`,
                }],
                tools: [],
                toolMode: "prompt-json",
                signal: input.signal,
            });
            return currentRound && (turn.toolCalls.length || turn.toolError) ? "" : turn.content.trim();
        } catch (error) {
            if (!isCanvasAgentContextLimitError(error) || text.length <= 4096) throw error;
            input.signal?.throwIfAborted();
            let middle = Math.floor(text.length / 2);
            if (/[\uDC00-\uDFFF]/.test(text[middle])) middle -= 1;
            const first = await summarize(text.slice(0, middle), checkpoint);
            return first ? summarize(text.slice(middle), first) : "";
        }
    };
    if (!currentRound) return summarize(source, previous);
    try {
        return await summarize(source, previous);
    } catch {
        input.signal?.throwIfAborted();
        return "";
    }
}

async function requestCompletion(config: CanvasAgentAiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal, onReasoning?: RequestCanvasAgentTurnInput["onReasoning"]) {
    if (config.apiMode === "responses") return requestResponsesCompletion(config, systemPrompt, messages, tools, jsonSchema, signal, onReasoning);
    if (isGeminiConfig(config)) return requestGeminiCompletion(config, systemPrompt, messages, tools, jsonSchema, signal, onReasoning);
    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "system", content: systemPrompt }, ...messages.map(toRequestMessage)],
        ...(config.textStreaming === true ? { stream: true } : {}),
    };
    if (config.textStreaming) body.stream_options = { include_usage: true };
    if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    if (jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "canvas_agent_actions", schema: jsonSchema } };
    applyCanvasAgentReasoning(body, config, "chat");

    const url = aiApiUrl(config, "/chat/completions");
    const response = await fetch(url, {
        method: "POST",
        headers: {
            ...aiHeaders(config, "application/json"),
            ...(config.canvasVideoAnalysisId && url.startsWith("/api/v1/") ? { "X-Canvas-Node-Request": "true" } : {}),
        },
        body: JSON.stringify(body),
        signal,
    });
    let payload: ChatCompletionPayload;
    let rawText = "";
    const streaming = config.textStreaming && response.ok && isEventStreamResponse(response);
    if (streaming) {
        let content = "";
        let reasoningContent = "";
        let finishReason = "";
        let usage: ChatCompletionPayload["usage"];
        const toolCalls: Array<{ id?: string; function: { name: string; arguments: string } }> = [];
        await readCanvasAgentStream(response, (event) => {
            if (event.usage) usage = event.usage as ChatCompletionPayload["usage"];
            const choice = (event.choices as Array<{
                delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
                };
                finish_reason?: string | null;
            }> | undefined)?.[0];
            if (!choice) return;
            if (choice.delta?.tool_calls?.length) config.onTextDelta?.(null);
            if (typeof choice.delta?.content === "string") {
                content += choice.delta.content;
                config.onTextDelta?.(choice.delta.content);
            }
            if (typeof choice.delta?.reasoning_content === "string") {
                reasoningContent += choice.delta.reasoning_content;
                onReasoning?.(choice.delta.reasoning_content);
            }
            if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
            for (const fragment of choice.delta?.tool_calls || []) {
                const index = typeof fragment.index === "number" ? fragment.index : toolCalls.length;
                const call: (typeof toolCalls)[number] = toolCalls[index] || { function: { name: "", arguments: "" } };
                if (fragment.id) call.id = fragment.id;
                if (fragment.function?.name) call.function.name += fragment.function.name;
                if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
                toolCalls[index] = call;
            }
        });
        if (!finishReason) throw new CanvasAgentRequestError("文本模型流式响应未完成", response.status);
        payload = {
            usage,
            choices: [{
                finish_reason: finishReason,
                message: { content, reasoning_content: reasoningContent || undefined, tool_calls: toolCalls },
            }],
        };
    } else {
        ({ payload, rawText } = await readResponsePayload<ChatCompletionPayload>(response));
    }
    const choice = payload.choices?.[0] || payload.data?.choices?.[0];
    const message = choice?.message;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || (typeof payload.code === "string" && payload.code !== "0" && !message)) {
        throw new CanvasAgentRequestError(
            tokenDanceRecoveryMessage(channelProtocolForConfig(config) === "tokendance" ? response.headers.get("TokenDance-Recovery-Action") : null)
                || readError(payload, response.status, rawText),
            response.status,
            readErrorCode(payload),
        );
    }
    if (!message) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);
    if (choice?.finish_reason && /^(?:length|content_filter|max_tokens)$/i.test(choice.finish_reason)) {
        throw new CanvasAgentRequestError("文本模型输出未完成：" + choice.finish_reason, response.status);
    }
    if (message.reasoning_content) onReasoning?.(streaming ? "\n\n" : message.reasoning_content + "\n\n");
    const normalizedModel = config.model.trim().toLowerCase();
    const preservesReasoningContent = normalizedModel.startsWith("glm-") || mimoTextModels.some((model) => model === normalizedModel);
    const reasoningContent = preservesReasoningContent && typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;

    const inputTokens = payload.usage?.prompt_tokens || payload.data?.usage?.prompt_tokens;
    if (!config.skipTokenCalibration) calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    if (!config.canvasVideoAnalysisId) refreshRemoteUser(config);
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

async function requestResponsesCompletion(config: CanvasAgentAiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal, onReasoning?: RequestCanvasAgentTurnInput["onReasoning"]) {
    const body: Record<string, unknown> = {
        model: config.model,
        instructions: systemPrompt,
        input: messages.flatMap(toResponsesInput),
        store: false,
        include: ["reasoning.encrypted_content"],
    };
    if (config.textStreaming) body.stream = true;
    if (tools.length) {
        body.tools = tools.map((tool) => ({ type: "function", ...tool.function }));
        body.tool_choice = "auto";
    }
    if (jsonSchema) body.text = { format: { type: "json_schema", name: "canvas_agent_actions", schema: jsonSchema } };
    applyCanvasAgentReasoning(body, config, "responses");

    const url = aiApiUrl(config, "/responses");
    const response = await fetch(url, {
        method: "POST",
        headers: {
            ...aiHeaders(config, "application/json"),
            ...(config.canvasVideoAnalysisId && url.startsWith("/api/v1/") ? { "X-Canvas-Node-Request": "true" } : {}),
        },
        body: JSON.stringify(body),
        signal,
    });
    let payload: ResponsesPayload;
    let rawText = "";
    const streamedReasoning = new Set<string>();
    let reasoningPart = "";
    if (config.textStreaming && response.ok && isEventStreamResponse(response)) {
        let terminal: ResponsesPayload | undefined;
        await readCanvasAgentStream(response, (event) => {
            if (event.type === "response.output_item.added" && (event.item as ResponsesOutputItem | undefined)?.type === "function_call") config.onTextDelta?.(null);
            if (event.type === "response.output_text.delta" && typeof event.delta === "string") config.onTextDelta?.(event.delta);
            if (onReasoning && typeof event.delta === "string" && event.delta &&
                (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta")) {
                const source = event.type === "response.reasoning_summary_text.delta" ? "summary" : "content";
                const part = `${event.output_index}:${source}:${event.summary_index ?? event.content_index ?? 0}`;
                onReasoning((reasoningPart && reasoningPart !== part ? "\n\n" : "") + event.delta);
                streamedReasoning.add(part);
                reasoningPart = part;
            }
            if (
                ["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))
                && event.response && typeof event.response === "object"
            ) terminal = event.response as ResponsesPayload;
        });
        if (!terminal) throw new CanvasAgentRequestError("文本模型流式响应未完成", response.status);
        payload = terminal;
    } else {
        ({ payload, rawText } = await readResponsePayload<ResponsesPayload>(response));
    }
    const result = payload.output ? payload : payload.data;
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || (typeof payload.code === "string" && payload.code !== "0" && !result)) {
        throw new CanvasAgentRequestError(
            tokenDanceRecoveryMessage(channelProtocolForConfig(config) === "tokendance" ? response.headers.get("TokenDance-Recovery-Action") : null)
                || readError(payload, response.status, rawText),
            response.status,
            readErrorCode(payload),
        );
    }
    if (payload.error) {
        const error = new CanvasAgentRequestError(readError(payload, response.status), response.status, readErrorCode(payload));
        if (isCanvasAgentContextLimitError(error)) throw error;
    }
    if (!result) throw new CanvasAgentRequestError(readError(payload, response.status) || "文本模型没有返回内容", response.status);
    const responseStatus = result.status?.toLowerCase();
    const incompleteReason = result.incomplete_details?.reason;
    if (incompleteReason || (responseStatus && ["incomplete", "failed", "cancelled", "in_progress", "queued"].includes(responseStatus))) {
        throw new CanvasAgentRequestError("文本模型输出未完成：" + (responseStatus || incompleteReason) + (responseStatus && incompleteReason ? "（" + incompleteReason + "）" : ""), response.status);
    }
    const output = result.output || [];
    if (onReasoning) {
        const reasoning = output.flatMap((item, index) => item.type === "reasoning" ? [
            ...(item.summary || []).map((part, partIndex) =>
                streamedReasoning.has(`${index}:summary:${partIndex}`) ? undefined : part.text),
            ...(item.content || []).map((part, partIndex) =>
                streamedReasoning.has(`${index}:content:${partIndex}`) ? undefined : part.text),
        ] : []).filter(Boolean).join("\n\n");
        if (reasoningPart) onReasoning("\n\n");
        if (reasoning) onReasoning(reasoning + "\n\n");
    }
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
    if (!config.skipTokenCalibration) calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    if (!config.canvasVideoAnalysisId) refreshRemoteUser(config);
    return {
        content: typeof result.output_text === "string" ? result.output_text : output.flatMap((item) => item.type === "message" ? item.content || [] : []).map((item) => item.type === "output_text" && typeof item.text === "string" ? item.text : "").join(""),
        responseItems,
        toolCalls,
        ...(toolError ? { toolError } : {}),
    };
}

async function requestGeminiCompletion(config: CanvasAgentAiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], jsonSchema?: Record<string, unknown>, signal?: AbortSignal, onReasoning?: RequestCanvasAgentTurnInput["onReasoning"]) {
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
            return dataUrlToGeminiInlineData(await imageToDataUrl({ dataUrl: part.image_url.url, url: part.image_url.url }));
        }));
        return { role: "user", parts };
    }));
    const extraSystemParts = messages.flatMap((message) => message.role !== "system" ? [] : typeof message.content === "string" ? [{ text: message.content }] : message.content.flatMap((part) => part.type === "text" ? [{ text: part.text }] : []));
    const body = {
        model: config.model,
        ...(config.textStreaming === true ? { stream: true } : {}),
        systemInstruction: { parts: [{ text: systemPrompt }, ...extraSystemParts] },
        contents,
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => tool.function) }] } : {}),
        ...(jsonSchema ? { generationConfig: { responseFormat: { text: { mimeType: "application/json", schema: jsonSchema } } } } : {}),
    };
    applyCanvasAgentReasoning(body, config, "gemini");
    const proxy = Boolean(aiApiUrl(config, "/chat/completions").startsWith("/api/"));
    const channel = localChannelForActiveModel(config);
    const { model: _model, stream: _stream, ...nativeBody } = body;
    const response = await fetch(proxy ? aiApiUrl(config, "/chat/completions") : geminiActionUrl(channel?.baseUrl || config.baseUrl, config.model, config.textStreaming ? "streamGenerateContent" : "generateContent"), {
        method: "POST",
        headers: proxy ? {
            ...aiHeaders(config, "application/json"),
            ...(config.canvasVideoAnalysisId ? {
                "X-Canvas-Node-Request": "true",
                "X-Canvas-Video-Analysis-ID": config.canvasVideoAnalysisId,
            } : {}),
        } : geminiDirectHeaders(config),
        body: JSON.stringify(proxy ? body : nativeBody),
        signal,
    });
    let payload: Record<string, unknown>;
    let rawText = "";
    const streaming = config.textStreaming && response.ok && isEventStreamResponse(response);
    if (streaming) {
        const parts: Array<Record<string, unknown>> = [];
        let finishReason: string | undefined;
        let usageMetadata: unknown;
        await readCanvasAgentStream(response, (event) => {
            const blockReason = (event.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
            if (blockReason) throw new CanvasAgentRequestError(blockReason, response.status);
            const candidates = Array.isArray(event.candidates) ? event.candidates as Array<Record<string, unknown>> : [];
            for (const candidate of candidates) {
                const content = candidate.content as { parts?: unknown } | undefined;
                if (Array.isArray(content?.parts)) {
                    for (const part of content.parts as Array<Record<string, unknown>>) {
                        parts.push(part);
                        if (part.functionCall) config.onTextDelta?.(null);
                        if (part.thought === true && typeof part.text === "string") onReasoning?.(part.text);
                        else if (typeof part.text === "string") config.onTextDelta?.(part.text);
                    }
                }
                if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
            }
            if (event.usageMetadata) usageMetadata = event.usageMetadata;
        });
        if (!finishReason) throw new CanvasAgentRequestError("文本模型流式响应未完成", response.status);
        payload = { candidates: [{ content: { parts }, finishReason }], usageMetadata };
    } else {
        ({ payload, rawText } = await readResponsePayload<Record<string, unknown>>(response));
    }
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
    if (onReasoning) {
        const reasoning = parts.map((part) => part.thought === true && typeof part.text === "string" ? part.text : "").join("");
        if (reasoning) onReasoning(streaming ? "\n\n" : reasoning + "\n\n");
    }
    const usageMetadata = payload.usageMetadata && typeof payload.usageMetadata === "object" ? payload.usageMetadata as Record<string, unknown> : {};
    const inputTokens = typeof usageMetadata.promptTokenCount === "number" ? usageMetadata.promptTokenCount : undefined;
    if (!config.skipTokenCalibration) calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(config), { systemPrompt, messages, tools }, inputTokens);
    if (!config.canvasVideoAnalysisId) refreshRemoteUser(config);
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
        content: parts.map((part) => typeof part.text === "string" && (!onReasoning || part.thought !== true) ? part.text : "").join(""),
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
                maxItems: tools.some(({ function: tool }) => tool.name === "present_choices") ? 13 : 12,
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

async function readCanvasAgentStream(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    try {
        await readJsonServerSentEvents(response, onEvent);
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof CanvasAgentRequestError) throw error;
        let code: string | undefined;
        if (error instanceof ImageRequestError && error.detail) {
            try {
                const detail = JSON.parse(error.detail) as AiErrorPayload & Record<string, unknown>;
                code = readErrorCode(detail) || geminiErrorCode(detail);
            } catch { /* 保留原始错误信息 */ }
        }
        throw new CanvasAgentRequestError(error instanceof Error ? error.message : "流式响应读取失败", response.status, code);
    }
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
