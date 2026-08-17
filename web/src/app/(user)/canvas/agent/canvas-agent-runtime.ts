import { requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import type { AiConfig } from "@/stores/use-config-store";
import type {
    CanvasAgentContent,
    CanvasAgentProtocolMessage,
    CanvasAgentState,
    CanvasAssistantMessageStatus,
    CanvasAssistantReference,
} from "../types";
import type { CanvasAgentContext } from "./canvas-agent-context";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import {
    CANVAS_AGENT_TOOLS,
    canvasAgentActionLabel,
    isCanvasAgentMediaAction,
    normalizeCanvasAgentAction,
    parseCanvasAgentJson,
    userLikelyRequestedCanvasAction,
    type CanvasAgentAction,
    type CanvasAgentToolResult,
} from "./canvas-agent-tools";

const MAX_AGENT_STEPS = 12;
const MAX_PROTOCOL_MESSAGES = 120;

function trimProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    const trimmed = messages.slice(-MAX_PROTOCOL_MESSAGES);
    while (trimmed[0]?.role === "tool") trimmed.shift();
    return trimmed;
}

export type CanvasAgentRuntimeEvent = {
    status: CanvasAssistantMessageStatus;
    label: string;
};

export type RunCanvasAgentInput = {
    config: AiConfig;
    initialState: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    userText: string;
    references: CanvasAssistantReference[];
    getContext: (state: CanvasAgentState) => CanvasAgentContext;
    executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>;
    onEvent?: (event: CanvasAgentRuntimeEvent) => void;
    onCheckpoint?: (checkpoint: { state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[] }) => void;
    signal?: AbortSignal;
};

export type RunCanvasAgentResult = {
    reply: string;
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
};

export function createCanvasAgentState(): CanvasAgentState {
    return {
        phase: "intake",
        approvedNodeIds: [],
        referenceNodeIds: [],
        pendingTaskIds: [],
        completedTaskIds: [],
    };
}

export async function runCanvasAgent(input: RunCanvasAgentInput): Promise<RunCanvasAgentResult> {
    let state = input.initialState;
    let allowTools = true;
    let hasExecutedActions = false;
    let protocolMessages: CanvasAgentProtocolMessage[] = trimProtocolMessages([
        ...input.protocolMessages,
        { role: "user" as const, content: buildUserContent(input.userText, input.references, input.config.textModel || input.config.model) },
    ]);

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
        const context = input.getContext(state);
        const turn = await requestCanvasAgentTurn({
            config: input.config,
            systemPrompt: buildCanvasAgentSkillPrompt(state.phase, input.userText, context),
            messages: protocolMessages,
            tools: CANVAS_AGENT_TOOLS,
            allowTools,
            signal: input.signal,
        });
        if (turn.usedJsonFallback) allowTools = false;

        const parsedJson = parseCanvasAgentJson(turn.content);
        const nativeActions = turn.toolCalls.map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id));
        const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
        const actions = (nativeActions.length ? nativeActions : parsedJson.actions).filter((action) => action.name !== "arrange_nodes" || arrangeRequested);

        if (!actions.length) {
            const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim();
            if (!hasExecutedActions && userLikelyRequestedCanvasAction(input.userText) && !looksLikeClarifyingQuestion(reply)) {
                const unsupported = "当前文本模型没有返回可执行的画布工具指令。可以继续讨论文本内容，但无法可靠地自动创建节点或执行生成；请在全局配置中更换支持 Tool Calling 或稳定 JSON 输出的文本模型。";
                protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: unsupported }]);
                return { reply: unsupported, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
            }
            const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: finalReply }]);
            return { reply: finalReply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
        }

        input.onEvent?.({ status: "running", label: actions.length === 1 ? canvasAgentActionLabel(actions[0]) : "正在执行 " + actions.length + " 个画布操作" });
        const assistantToolMessage: CanvasAgentProtocolMessage = nativeActions.length
            ? { role: "assistant", content: turn.content || undefined, ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}), toolCalls: actions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })) }
            : { role: "assistant", content: turn.content };

        const results = await executeActions(actions, state, input.executeAction, input.signal, input.onEvent);
        hasExecutedActions = true;
        state = results.state;

        if (nativeActions.length && allowTools) {
            protocolMessages = trimProtocolMessages([
                ...protocolMessages,
                assistantToolMessage,
                ...results.items.map(({ action, result }) => ({
                    role: "tool" as const,
                    toolCallId: action.id,
                    name: action.name,
                    content: JSON.stringify(result),
                })),
            ]);
        } else {
            protocolMessages = trimProtocolMessages([
                ...protocolMessages,
                assistantToolMessage,
                {
                    role: "user" as const,
                    content: "工具执行结果（只可依据这些真实结果继续）：\n" + JSON.stringify(results.items.map(({ action, result }) => ({ tool: action.name, id: action.id, result }))),
                },
            ]);
        }
        input.onCheckpoint?.({ state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) });
    }

    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: reply }]);
    return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
}

async function executeActions(
    actions: CanvasAgentAction[],
    initialState: CanvasAgentState,
    executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>,
    signal?: AbortSignal,
    onEvent?: (event: CanvasAgentRuntimeEvent) => void,
) {
    let state = initialState;
    const executeOne = async (action: CanvasAgentAction) => {
        throwIfAborted(signal);
        onEvent?.({ status: "running", label: canvasAgentActionLabel(action) });
        try {
            const result = await executeAction(action);
            if (action.name === "set_agent_state" && result.ok) state = applyAgentState(state, action.arguments);
            else state = applyTaskResult(state, result);
            return { action, result };
        } catch (error) {
            return {
                action,
                result: {
                    ok: false,
                    code: "tool_execution_failed",
                    message: error instanceof Error ? error.message : "工具执行失败",
                } satisfies CanvasAgentToolResult,
            };
        }
    };

    const items = actions.every(isCanvasAgentMediaAction)
        ? await Promise.all(actions.map(executeOne))
        : await actions.reduce<Promise<Array<{ action: CanvasAgentAction; result: CanvasAgentToolResult }>>>(
            async (pending, action) => [...(await pending), await executeOne(action)],
            Promise.resolve([]),
        );
    return { items, state };
}

function buildUserContent(text: string, references: CanvasAssistantReference[], modelName: string): CanvasAgentContent {
    const referenceText = references.length ? "\n\n本次明确引用的真实节点：" + references.map((item) => item.id + "（" + item.title + "）").join("、") : "";
    const images = supportsCanvasAgentImageInput(modelName)
        ? references.flatMap((item) => {
            const url = item.dataUrl;
            return url && (/^data:image\//.test(url) || /^https?:\/\//.test(url)) ? [{ type: "image_url" as const, image_url: { url } }] : [];
        })
        : [];
    if (!images.length) return text + referenceText;
    return [{ type: "text", text: text + referenceText }, ...images];
}

function supportsCanvasAgentImageInput(modelName: string) {
    const model = modelName.trim().toLowerCase();
    return model === "mimo-v2.5" || /gpt-(?:4o|4\.1|5)|(?:^|[\\/_-])o[134](?:[\\/_-]|$)|gemini|claude|qwen.*(?:vl|vision)|glm-4v|pixtral|llava|internvl|deepseek.*vl|vision/.test(model);
}

function looksLikeClarifyingQuestion(text: string) {
    return /[?？]|请(?:告诉|选择|确认|提供)|需要.{0,12}(?:吗|呢)|希望.{0,12}(?:吗|呢)/.test(text);
}

function persistCanvasAgentProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message): CanvasAgentProtocolMessage => {
        if ((message.role === "user" || message.role === "system") && Array.isArray(message.content)) {
            const text = message.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n")
                .trim();
            return { role: message.role, content: text || "本轮包含图片引用；媒体内容未写入会话记录。" };
        }
        return message;
    });
}

function applyAgentState(state: CanvasAgentState, patch: Record<string, unknown>): CanvasAgentState {
    return {
        ...state,
        phase: typeof patch.phase === "string" ? (patch.phase as CanvasAgentState["phase"]) : state.phase,
        brief: typeof patch.brief === "string" ? patch.brief : state.brief,
        targetDurationSeconds: typeof patch.targetDurationSeconds === "number" ? patch.targetDurationSeconds : state.targetDurationSeconds,
        approvedPlan: typeof patch.approvedPlan === "string" ? patch.approvedPlan : state.approvedPlan,
        approvedNodeIds: Array.isArray(patch.approvedNodeIds) ? (patch.approvedNodeIds as string[]) : state.approvedNodeIds,
        referenceNodeIds: Array.isArray(patch.referenceNodeIds) ? (patch.referenceNodeIds as string[]) : state.referenceNodeIds,
    };
}

function applyTaskResult(state: CanvasAgentState, result: CanvasAgentToolResult): CanvasAgentState {
    const taskId = typeof result.taskId === "string" ? result.taskId : "";
    if (!taskId) return state;
    const completed = result.status === "success" || result.status === "completed";
    const terminal = completed || result.status === "error" || result.status === "failed";
    return {
        ...state,
        pendingTaskIds: terminal ? state.pendingTaskIds.filter((id) => id !== taskId) : [...new Set([...state.pendingTaskIds, taskId])],
        completedTaskIds: completed ? [...new Set([...state.completedTaskIds, taskId])] : state.completedTaskIds,
    };
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("Agent 已停止");
    error.name = "AbortError";
    throw error;
}
