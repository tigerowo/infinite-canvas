import {
    canvasAgentSystemPrompt,
    canvasAgentTokenCalibrationKey,
    isCanvasAgentContextLimitError,
    requestCanvasAgentCheckpoint,
    requestCanvasAgentTurn,
} from "@/services/api/canvas-agent";
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
    compactCanvasAgentHistory,
    estimateCanvasAgentInputTokens,
    MAX_AGENT_INPUT_TOKENS,
    serializeCanvasAgentMessagesForCheckpoint,
} from "./canvas-agent-memory";
import {
    CANVAS_AGENT_SKILL_FILE_TOOL,
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

export type CanvasAgentRuntimeEvent = {
    status: CanvasAssistantMessageStatus;
    label: string;
};

export type RunCanvasAgentInput = {
    config: AiConfig;
    interactionMode: "quick" | "agent";
    initialState: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    userText: string;
    references: CanvasAssistantReference[];
    activeSkillContents?: Array<{ id: string; source: "system" | "user"; name: string; content: string; hasFiles?: boolean }>;
    contextCheckpoint?: string;
    getContext: (state: CanvasAgentState) => CanvasAgentContext;
    executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>;
    onEvent?: (event: CanvasAgentRuntimeEvent) => void;
    onCheckpoint?: (checkpoint: {
        state: CanvasAgentState;
        protocolMessages: CanvasAgentProtocolMessage[];
        contextCheckpoint?: string;
    }) => void;
    signal?: AbortSignal;
};

export type RunCanvasAgentResult = {
    reply: string;
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    contextCheckpoint?: string;
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
    let protocolMessages: CanvasAgentProtocolMessage[] = [
        ...input.protocolMessages,
        { role: "user" as const, content: buildUserContent(input.userText, input.references, input.config.textModel || input.config.model) },
    ];
    let contextCheckpoint = input.contextCheckpoint;
    const activeSkillContents = input.activeSkillContents?.map((skill, index) => `【完整 Skill ${index + 1}：${skill.name}（${skill.source === "system" ? `系统 Skill ID：${skill.id}` : "用户 Skill"}）】\n${skill.content}`).join("\n\n");
    const skillFileToolAvailable = Boolean(input.activeSkillContents?.some((skill) => skill.source === "system" && skill.hasFiles));
    const agentTools = skillFileToolAvailable ? [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL] : CANVAS_AGENT_TOOLS;

    const emitCheckpoint = () => input.onCheckpoint?.({
        state,
        protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages),
        contextCheckpoint,
    });

    const compactHistory = async () => {
        const compacted = await compactCanvasAgentHistory({
            protocolMessages,
            contextCheckpoint,
            createCheckpoint: (previousCheckpoint, messages) => requestCanvasAgentCheckpoint({
                config: input.config,
                previousCheckpoint,
                messages: serializeCanvasAgentMessagesForCheckpoint(messages),
                signal: input.signal,
            }),
        });
        if (!compacted.compacted) return false;
        protocolMessages = compacted.protocolMessages;
        contextCheckpoint = compacted.contextCheckpoint;
        emitCheckpoint();
        return true;
    };

    if (input.interactionMode === "quick") {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: "正在快速回答" });
        const turn = await requestCanvasAgentTurn({
            config: input.config,
            systemPrompt: buildQuickCanvasPrompt(input.getContext(state)),
            messages: quickCanvasMessages(protocolMessages),
            tools: [],
            allowTools: false,
            signal: input.signal,
        });
        const parsedJson = parseCanvasAgentJson(turn.content);
        const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim() || "模型没有返回内容，请重试或切换到画布 Agent。";
        protocolMessages = [...protocolMessages, { role: "assistant", content: reply, ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}) }];
        return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
    }

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
        const context = input.getContext(state);
        let systemPrompt = buildCanvasAgentSkillPrompt(state.phase, input.userText, context, activeSkillContents, contextCheckpoint, skillFileToolAvailable);
        const tools = allowTools ? agentTools : [];
        if (estimateCanvasAgentInputTokens({ systemPrompt: canvasAgentSystemPrompt(input.config, systemPrompt), messages: protocolMessages, tools }, canvasAgentTokenCalibrationKey(input.config)) >= MAX_AGENT_INPUT_TOKENS) {
            if (await compactHistory()) systemPrompt = buildCanvasAgentSkillPrompt(state.phase, input.userText, context, activeSkillContents, contextCheckpoint, skillFileToolAvailable);
        }

        const requestTurn = () => requestCanvasAgentTurn({
            config: input.config,
            systemPrompt,
            messages: protocolMessages,
            tools: agentTools,
            allowTools,
            signal: input.signal,
        });
        let turn: Awaited<ReturnType<typeof requestCanvasAgentTurn>>;
        try {
            turn = await requestTurn();
        } catch (error) {
            if (!isCanvasAgentContextLimitError(error) || !(await compactHistory())) throw error;
            systemPrompt = buildCanvasAgentSkillPrompt(state.phase, input.userText, context, activeSkillContents, contextCheckpoint, skillFileToolAvailable);
            turn = await requestTurn();
        }
        if (turn.usedJsonFallback) allowTools = false;

        const parsedJson = parseCanvasAgentJson(turn.content);
        const nativeActions = turn.toolCalls.map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id));
        const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
        const requestedActions = nativeActions.length ? nativeActions : parsedJson.actions;
        const actions = requestedActions.filter((action) => action.name !== "arrange_nodes" || arrangeRequested);
        const rejectedToolMessages: CanvasAgentProtocolMessage[] = nativeActions.filter((action) => action.name === "arrange_nodes" && !arrangeRequested).map((action) => ({
            role: "tool",
            toolCallId: action.id,
            name: action.name,
            content: JSON.stringify({ ok: false, code: "action_not_requested", message: "用户没有要求整理画布，未执行节点排列" }),
        }));

        if (!actions.length && rejectedToolMessages.length) {
            protocolMessages = [
                ...protocolMessages,
                { role: "assistant", content: turn.content || undefined, ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}), responseItems: turn.responseItems, toolCalls: nativeActions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })) },
                ...rejectedToolMessages,
            ];
            emitCheckpoint();
            continue;
        }

        if (!actions.length) {
            const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim();
            if (!hasExecutedActions && !reply && userLikelyRequestedCanvasAction(input.userText)) {
                const unsupported = "当前接口没有返回可执行的画布工具指令。请点击输入框右下角的大脑图标，尝试切换 Chat / Responses，或更换支持 Tool Calling 或稳定 JSON 输出的文本模型。";
                protocolMessages = [...protocolMessages, { role: "assistant" as const, content: unsupported }];
                return { reply: unsupported, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
            }
            const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages = [...protocolMessages, { role: "assistant" as const, content: finalReply, ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}) }];
            return { reply: finalReply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
        }

        input.onEvent?.({ status: "running", label: actions.length === 1 ? canvasAgentActionLabel(actions[0]) : "正在执行 " + actions.length + " 个画布操作" });
        const assistantToolMessage: CanvasAgentProtocolMessage = nativeActions.length
            ? { role: "assistant", content: turn.content || undefined, ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}), ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}), toolCalls: nativeActions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })) }
            : { role: "assistant", content: turn.content };

        const results = await executeActions(actions, state, input.executeAction, input.signal, input.onEvent);
        hasExecutedActions = true;
        state = results.state;

        if (nativeActions.length && allowTools) {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                ...results.items.map(({ action, result }) => ({
                    role: "tool" as const,
                    toolCallId: action.id,
                    name: action.name,
                    content: JSON.stringify(result),
                })),
                ...rejectedToolMessages,
            ];
        } else {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                {
                    role: "user" as const,
                    content: "工具执行结果（只可依据这些真实结果继续）：\n" + JSON.stringify(results.items.map(({ action, result }) => ({ tool: action.name, id: action.id, result }))),
                },
            ];
        }
        emitCheckpoint();
    }

    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    protocolMessages = [...protocolMessages, { role: "assistant" as const, content: reply }];
    return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
}

function quickCanvasMessages(messages: CanvasAgentProtocolMessage[]) {
    return persistCanvasAgentProtocolMessages(messages).flatMap((message): CanvasAgentProtocolMessage[] => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        const content = typeof message.content === "string" ? message.content.trim() : "";
        if (!content) return [];
        return message.role === "user"
            ? [{ role: "user", content }]
            : [{ role: "assistant", content }];
    }).slice(-8);
}

function buildQuickCanvasPrompt(context: CanvasAgentContext) {
    const selectedIds = new Set(context.selectedNodeIds);
    const selectedNodes = context.nodes.filter((node) => selectedIds.has(node.id));
    const nodes = (selectedNodes.length ? selectedNodes : context.nodes.slice(0, 12)).map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        text: node.text?.slice(0, 600),
        prompt: node.prompt?.slice(0, 600),
        status: node.status,
        model: node.model,
    }));
    return [
        "你是 Infinite Canvas 的快速对话助手。直接、简洁地回答用户问题。",
        "本模式不调用工具，不创建、删除或修改画布节点。用户要求操作画布时，请明确提示切换到“画布 Agent”模式。",
        `当前画布摘要：${JSON.stringify({ project: context.project, selectedNodeIds: context.selectedNodeIds, nodes })}`,
    ].join("\n");
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
    const referenceText = references.length
        ? "\n\n本次输入中的节点占位与真实节点一一对应，请按占位分别理解和操作：" + references.map((item) => `${item.label || item.title} → 节点 ${item.id}（${item.title}）`).join("；")
        : "";
    const imageReferences = references.filter((item) => item.dataUrl && (/^data:image\//.test(item.dataUrl) || /^https?:\/\//.test(item.dataUrl)));
    const imageOrderText = imageReferences.length ? "\n随消息附带的图片顺序：" + imageReferences.map((item, index) => `第 ${index + 1} 张 = ${item.label || item.title}`).join("；") : "";
    const images = supportsCanvasAgentImageInput(modelName)
        ? imageReferences.map((item) => ({ type: "image_url" as const, image_url: { url: item.dataUrl as string } }))
        : [];
    if (!images.length) return text + referenceText;
    return [{ type: "text", text: text + referenceText + imageOrderText }, ...images];
}

function supportsCanvasAgentImageInput(modelName: string) {
    const model = modelName.trim().toLowerCase();
    return model === "mimo-v2.5" || /gpt-(?:4o|4\.1|5)|(?:^|[\\/_-])o[134](?:[\\/_-]|$)|gemini|claude|qwen.*(?:vl|vision)|glm-4v|pixtral|llava|internvl|deepseek.*vl|vision/.test(model);
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
