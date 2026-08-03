import type { ChatCompletionMessage } from "@/services/api/image";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { VideoElementItem, VideoElementReference, VideoMultiPromptItem } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    firstFrame: ReferenceImage | null;
    lastFrame: ReferenceImage | null;
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt, sourceNode);
    }

    const advanced = buildCanvasVideoAdvancedContext(sourceNode, inputs);
    const upstreamText = sourceNode?.metadata?.excludeUpstreamText? "": inputs
            .filter((input) => !advanced.textNodeIds.has(input.nodeId))
            .map((input) => input.text)
            .filter(Boolean)
            .join("\n\n");
    const referenceImages = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const frameReferences = readFrameReferences(sourceNode, inputs);
    const frameNodeIds = new Set([frameReferences.firstFrame?.id, frameReferences.lastFrame?.id].filter((id): id is string => Boolean(id)));
    const effectiveReferenceImages = referenceImages.filter((image) => !frameNodeIds.has(image.id));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages: [...advanced.klingImageReferences, ...effectiveReferenceImages],
        firstFrame: frameReferences.firstFrame,
        lastFrame: frameReferences.lastFrame,
        referenceVideos,
        referenceAudios,
        videoMultiPrompt: advanced.videoMultiPrompt,
        videoElementList: advanced.videoElementList,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, sourceNode?: CanvasNodeData): NodeGenerationContext {
    const advanced = buildCanvasVideoAdvancedContext(sourceNode, inputs);
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input && !advanced.textNodeIds.has(input.nodeId) && !advanced.referenceNodeIds.has(input.nodeId)) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]++);
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const frameReferences = readFrameReferences(sourceNode, inputs);
    const frameNodeIds = new Set([frameReferences.firstFrame?.id, frameReferences.lastFrame?.id].filter((id): id is string => Boolean(id)));
    const effectiveReferenceImages = referenceImages.filter((image) => !frameNodeIds.has(image.id));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: advanced.klingImageReferences,
            firstFrame: frameReferences.firstFrame,
            lastFrame: frameReferences.lastFrame,
            referenceVideos: [],
            referenceAudios: [],
            videoMultiPrompt: advanced.videoMultiPrompt,
            videoElementList: advanced.videoElementList,
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages: [...advanced.klingImageReferences, ...effectiveReferenceImages],
        firstFrame: frameReferences.firstFrame,
        lastFrame: frameReferences.lastFrame,
        referenceVideos,
        referenceAudios,
        videoMultiPrompt: advanced.videoMultiPrompt,
        videoElementList: advanced.videoElementList,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

type CanvasVideoAdvancedContext = {
    textNodeIds: Set<string>;
    referenceNodeIds: Set<string>;
    klingImageReferences: ReferenceImage[];
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
};

function buildCanvasVideoAdvancedContext(sourceNode: CanvasNodeData | undefined, inputs: NodeGenerationInput[]): CanvasVideoAdvancedContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const textNodeIds = new Set<string>();
    const referenceNodeIds = new Set<string>();
    const klingImageReferences = (sourceNode?.metadata?.klingImageNodeIds || [])
        .map((nodeId) => {
            referenceNodeIds.add(nodeId);
            return inputByNodeId.get(nodeId)?.image || null;
        })
        .filter((image): image is ReferenceImage => Boolean(image));
    const videoMultiPrompt = (sourceNode?.metadata?.klingMultiPrompt || [])
        .map((item) => {
            const nodeId = item.textNodeId || "";
            const input = inputByNodeId.get(nodeId);
            if (!nodeId || input?.type !== "text" || !input.text) return null;
            textNodeIds.add(nodeId);
            return { prompt: input.text, duration: item.duration || "1" };
        })
        .filter((item): item is VideoMultiPromptItem => Boolean(item));
    const videoElementList = (sourceNode?.metadata?.klingElementList || [])
        .slice(0, 3)
        .map((item) => {
            const references = (item.nodeIds || [])
                .slice(0, 4)
                .map((nodeId) => {
                    referenceNodeIds.add(nodeId);
                    return inputToElementReference(inputByNodeId.get(nodeId));
                })
                .filter((reference): reference is VideoElementReference => Boolean(reference));
            return references.length ? { name: item.name || "", description: item.description || "", references } : null;
        })
        .filter((item): item is VideoElementItem => Boolean(item));
    return { textNodeIds, referenceNodeIds, klingImageReferences, videoMultiPrompt, videoElementList };
}

function inputToElementReference(input: NodeGenerationInput | undefined): VideoElementReference | null {
    if (input?.image) return { id: input.nodeId, kind: "image", name: input.image.name, type: input.image.type, dataUrl: input.image.dataUrl, storageKey: input.image.storageKey };
    if (input?.video) return { id: input.nodeId, kind: "video", name: input.video.name, type: input.video.type, url: input.video.url, storageKey: input.video.storageKey, bytes: input.video.bytes, width: input.video.width, height: input.video.height, durationMs: input.video.durationMs };
    if (input?.audio) return { id: input.nodeId, kind: "audio", name: input.audio.name, type: input.audio.type, url: input.audio.url, storageKey: input.audio.storageKey, durationMs: input.audio.durationMs };
    return null;
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

export function buildNodeChatMessages(context: NodeGenerationContext): ChatCompletionMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return {
        ...context,
        referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))),
        firstFrame: context.firstFrame ? { ...context.firstFrame, dataUrl: await imageToDataUrl(context.firstFrame) } : null,
        lastFrame: context.lastFrame ? { ...context.lastFrame, dataUrl: await imageToDataUrl(context.lastFrame) } : null,
    };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return seedanceReferenceLabel("video", index);
    if (type === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (!isCanvasImageNodeType(node.type) || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `image-${node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readFrameReferences(node: CanvasNodeData | undefined, inputs: NodeGenerationInput[]) {
    const imageByNodeId = new Map(inputs.filter((input) => input.image).map((input) => [input.nodeId, input.image as ReferenceImage]));
    return {
        firstFrame: node?.metadata?.firstFrameNodeId ? imageByNodeId.get(node.metadata.firstFrameNodeId) || null : null,
        lastFrame: node?.metadata?.lastFrameNodeId ? imageByNodeId.get(node.metadata.lastFrameNodeId) || null : null,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `video-${node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `audio-${node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
