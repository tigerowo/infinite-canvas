import type { CanvasAgentProtocolMessage } from "../types";
import type { CanvasAgentToolDefinition } from "./canvas-agent-tools";

export const MAX_AGENT_INPUT_TOKENS = 260_000;
const MAX_RECENT_PROTOCOL_TOKENS = 64_000;
const MAX_COMPACTED_CONTEXT_TOKENS = 16_000;

type CanvasAgentInput = {
    systemPrompt: string;
    messages: CanvasAgentProtocolMessage[];
    tools: CanvasAgentToolDefinition[];
};

type CompactCanvasAgentHistoryInput = {
    protocolMessages: CanvasAgentProtocolMessage[];
    contextCheckpoint?: string;
    createCheckpoint: (previousCheckpoint: string | undefined, messages: CanvasAgentProtocolMessage[]) => Promise<string>;
};

const calibrationFactors = new Map<string, number>();
const encoder = new TextEncoder();

export function estimateCanvasAgentInputTokens(input: CanvasAgentInput, calibrationKey?: string) {
    const base = estimateCanvasAgentInputTokensBase(input);
    return Math.ceil(base * (calibrationKey ? calibrationFactors.get(calibrationKey) || 1.25 : 1.25));
}

export function calibrateCanvasAgentTokenEstimate(calibrationKey: string, input: CanvasAgentInput, actualInputTokens?: number) {
    if (!actualInputTokens || actualInputTokens <= 0) return;
    const base = estimateCanvasAgentInputTokensBase(input);
    if (!base) return;
    const nextFactor = Math.min(4, Math.max(1.08, (actualInputTokens / base) * 1.08));
    calibrationFactors.set(calibrationKey, Math.max(calibrationFactors.get(calibrationKey) || 0, nextFactor));
}

function estimateCanvasAgentProtocolTokens(messages: CanvasAgentProtocolMessage[]) {
    return messages.reduce((total, message) => total + estimateProtocolMessageTokens(message), 0);
}

export async function compactCanvasAgentHistory(input: CompactCanvasAgentHistoryInput) {
    const { fixedMessages, completedRounds, unfinishedRound } = groupProtocolMessages(input.protocolMessages);
    const keptRounds: CanvasAgentProtocolMessage[][] = [];
    const compactedRounds: CanvasAgentProtocolMessage[][] = [];
    let recentTokens = 0;

    for (let index = completedRounds.length - 1; index >= 0; index -= 1) {
        const round = completedRounds[index];
        const roundTokens = estimateCanvasAgentProtocolTokens(round);
        if (recentTokens + roundTokens <= MAX_RECENT_PROTOCOL_TOKENS) {
            keptRounds.unshift(round);
            recentTokens += roundTokens;
        } else {
            compactedRounds.unshift(round);
        }
    }

    const messagesToCompact = compactedRounds.flat();
    if (!messagesToCompact.length) {
        return { compacted: false, contextCheckpoint: input.contextCheckpoint, protocolMessages: input.protocolMessages };
    }

    let checkpoint = await input.createCheckpoint(input.contextCheckpoint, messagesToCompact);
    if (!checkpoint.trim()) checkpoint = await input.createCheckpoint(input.contextCheckpoint, messagesToCompact);
    if (!checkpoint.trim()) {
        return { compacted: false, contextCheckpoint: input.contextCheckpoint, protocolMessages: input.protocolMessages };
    }
    return {
        compacted: true,
        contextCheckpoint: truncateToEstimatedTokens(checkpoint.trim(), MAX_COMPACTED_CONTEXT_TOKENS),
        protocolMessages: [...fixedMessages, ...keptRounds.flat(), ...unfinishedRound],
    };
}

export function serializeCanvasAgentMessagesForCheckpoint(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message) => {
        if (message.role === "assistant") {
            return {
                role: message.role,
                content: message.content || "",
                toolCalls: message.toolCalls?.map((call) => ({ name: call.name, arguments: call.arguments })),
            };
        }
        if (message.role === "tool") return { role: message.role, name: message.name, content: message.content };
        return { role: message.role, content: textContent(message.content) };
    });
}

function estimateCanvasAgentInputTokensBase(input: CanvasAgentInput) {
    return estimateTextTokens(input.systemPrompt)
        + estimateTextTokens(JSON.stringify(input.tools))
        + estimateCanvasAgentProtocolTokens(input.messages)
        + input.messages.length * 6
        + input.tools.length * 10;
}

function estimateProtocolMessageTokens(message: CanvasAgentProtocolMessage) {
    if (message.role === "assistant") {
        if (message.responseItems?.length) return estimateTextTokens(JSON.stringify(message.responseItems)) + 8;
        return estimateTextTokens(message.content || "")
            + estimateTextTokens(message.reasoningContent || "")
            + estimateTextTokens(JSON.stringify(message.toolCalls || []))
            + 8;
    }
    if (message.role === "tool") return estimateTextTokens(message.name) + estimateTextTokens(message.content) + 8;
    return estimateTextTokens(textContent(message.content)) + (typeof message.content === "string" ? 8 : message.content.filter((part) => part.type === "image_url").length * 1024 + 8);
}

function estimateTextTokens(value: string) {
    return value ? Math.ceil(encoder.encode(value).length / 3) : 0;
}

function textContent(content: Extract<CanvasAgentProtocolMessage, { role: "user" | "system" }>["content"]) {
    if (typeof content === "string") return content;
    return content.map((part) => part.type === "text" ? part.text : "[媒体引用]").join("\n");
}

function groupProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    const fixedMessages: CanvasAgentProtocolMessage[] = [];
    const rounds: CanvasAgentProtocolMessage[][] = [];
    let current: CanvasAgentProtocolMessage[] = [];

    messages.forEach((message) => {
        if (isRealUserMessage(message)) {
            if (current.length) rounds.push(current);
            current = [message];
        } else if (current.length) {
            current.push(message);
        } else {
            fixedMessages.push(message);
        }
    });
    if (current.length) rounds.push(current);

    const completedRounds: CanvasAgentProtocolMessage[][] = [];
    let unfinishedRound: CanvasAgentProtocolMessage[] = [];
    rounds.forEach((round, index) => {
        const completed = round.some((message, messageIndex) => message.role === "assistant" && !message.toolCalls?.length && !isFollowedByToolFallback(round, messageIndex));
        if (completed || index < rounds.length - 1) completedRounds.push(round);
        else unfinishedRound = round;
    });
    return { fixedMessages, completedRounds, unfinishedRound };
}

function isRealUserMessage(message: CanvasAgentProtocolMessage) {
    return message.role === "user" && !textContent(message.content).startsWith("工具执行结果（只可依据这些真实结果继续）：");
}

function isFollowedByToolFallback(round: CanvasAgentProtocolMessage[], index: number) {
    const next = round[index + 1];
    return next?.role === "user" && textContent(next.content).startsWith("工具执行结果（只可依据这些真实结果继续）：");
}

function truncateToEstimatedTokens(value: string, maxTokens: number) {
    if (estimateTextTokens(value) <= maxTokens) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateTextTokens(value.slice(0, middle)) <= maxTokens) low = middle;
        else high = middle - 1;
    }
    return value.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
}
