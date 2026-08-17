import { isGlmTtsModel } from "@/lib/audio-generation";
import { supportsVideoAudioGeneration } from "@/lib/video-model-capabilities";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasAgentState, type CanvasConnection, type CanvasNodeData } from "../types";

export type CanvasAgentContextNode = {
    id: string;
    type: CanvasNodeType;
    title: string;
    text?: string;
    mediaUrl?: string;
    hasMedia?: boolean;
    status?: string;
    prompt?: string;
    model?: string;
    size?: string;
    seconds?: string;
    generateAudio?: string;
    taskId?: string;
    error?: string;
    groupId?: string;
};

export type CanvasAgentContext = {
    project: {
        id: string;
        title: string;
        nodeCount: number;
        connectionCount: number;
    };
    agentState: CanvasAgentState;
    selectedNodeIds: string[];
    nodes: CanvasAgentContextNode[];
    connections: CanvasConnection[];
    generation: {
        textModel: string;
        imageModel: string;
        videoModel: string;
        audioModel: string;
        imageQuality: string;
        imageSize: string;
        videoQuality: string;
        videoSize: string;
        imageCount: string;
        videoSeconds: string;
        videoGenerateAudio: string;
        videoSupportsAudio: boolean;
        audioVoice: string;
        audioFormat: string;
    };
    tasks: Array<{
        nodeId: string;
        type: CanvasNodeType;
        status: string;
        taskId: string;
        progress?: number;
        error?: string;
    }>;
};

type BuildCanvasAgentContextInput = {
    projectId: string;
    projectTitle: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Iterable<string>;
    config: AiConfig;
    agentState: CanvasAgentState;
};

const MAX_CONTEXT_NODES = 120;
const MAX_TEXT_LENGTH = 4000;

export function buildCanvasAgentContext(input: BuildCanvasAgentContextInput): CanvasAgentContext {
    const selectedNodeIds = Array.from(input.selectedNodeIds);
    const prioritizedIds = new Set<string>([
        ...selectedNodeIds,
        ...input.agentState.approvedNodeIds,
        ...input.agentState.referenceNodeIds,
    ]);
    input.connections.forEach((connection) => {
        if (prioritizedIds.has(connection.fromNodeId) || prioritizedIds.has(connection.toNodeId)) {
            prioritizedIds.add(connection.fromNodeId);
            prioritizedIds.add(connection.toNodeId);
        }
    });
    input.nodes.forEach((node) => {
        if (node.metadata?.status === "loading" || node.metadata?.status === "error") prioritizedIds.add(node.id);
    });

    const orderedNodes = [
        ...input.nodes.filter((node) => prioritizedIds.has(node.id)),
        ...input.nodes.filter((node) => !prioritizedIds.has(node.id)),
    ].slice(0, MAX_CONTEXT_NODES);
    const includedIds = new Set(orderedNodes.map((node) => node.id));
    const videoModel = input.config.videoModel || input.config.model;

    return {
        project: {
            id: input.projectId,
            title: input.projectTitle,
            nodeCount: input.nodes.length,
            connectionCount: input.connections.length,
        },
        agentState: input.agentState,
        selectedNodeIds,
        nodes: orderedNodes.map(summarizeNode),
        connections: input.connections.filter((connection) => includedIds.has(connection.fromNodeId) && includedIds.has(connection.toNodeId)),
        generation: {
            textModel: input.config.textModel || input.config.model,
            imageModel: input.config.imageModel || input.config.model,
            videoModel,
            audioModel: input.config.audioModel,
            imageQuality: input.config.quality,
            imageSize: input.config.size,
            videoQuality: input.config.vquality,
            videoSize: input.config.videoSize,
            imageCount: input.config.canvasImageCount || input.config.count,
            videoSeconds: input.config.videoSeconds,
            videoGenerateAudio: input.config.videoGenerateAudio,
            videoSupportsAudio: supportsVideoAudioGeneration(videoModel),
            audioVoice: isGlmTtsModel(input.config.audioModel) ? input.config.glmTtsVoice : input.config.audioVoice,
            audioFormat: isGlmTtsModel(input.config.audioModel) ? input.config.glmTtsFormat : input.config.audioFormat,
        },
        tasks: orderedNodes.flatMap((node) => {
            const taskId = mediaTaskId(node);
            if (!taskId) return [];
            return [
                {
                    nodeId: node.id,
                    type: node.type,
                    status: node.metadata?.status || "idle",
                    taskId,
                    progress: node.metadata?.progress,
                    error: node.metadata?.errorDetails,
                },
            ];
        }),
    };
}

export function serializeCanvasAgentContext(context: CanvasAgentContext) {
    return JSON.stringify(context);
}

function summarizeNode(node: CanvasNodeData): CanvasAgentContextNode {
    const content = node.metadata?.content || "";
    const isText = node.type === CanvasNodeType.Text;
    const mediaUrl = !isText && content && !content.startsWith("data:") ? content : undefined;
    return {
        id: node.id,
        type: node.type,
        title: node.title,
        text: isText && content ? content.slice(0, MAX_TEXT_LENGTH) : undefined,
        mediaUrl,
        hasMedia: !isText ? Boolean(content) : undefined,
        status: node.metadata?.status,
        prompt: node.metadata?.prompt?.slice(0, MAX_TEXT_LENGTH),
        model: node.metadata?.model,
        size: node.metadata?.size,
        seconds: node.metadata?.seconds,
        generateAudio: node.metadata?.generateAudio,
        taskId: mediaTaskId(node) || undefined,
        error: node.metadata?.errorDetails,
        groupId: node.metadata?.groupId,
    };
}

function mediaTaskId(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Video) return node.metadata?.videoTaskId || "";
    if (node.type === CanvasNodeType.Audio) return node.metadata?.audioTaskId || "";
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Panorama) return node.metadata?.imageTaskId || "";
    return "";
}
