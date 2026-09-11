import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { fitNodeSize } from "@/app/(user)/canvas/utils/canvas-node-size";
import { isTaskLookupRetry, isTaskTerminal } from "./task-state";

export function applyMediaDimensions(node: CanvasNodeData, source: string, width: number, height: number): CanvasNodeData {
    if (node.metadata?.content !== source || ![CanvasNodeType.Image, CanvasNodeType.Video].includes(node.type) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return node;
    const keepBox = node.metadata.freeResize || Math.abs(node.width / node.height - width / height) < 0.001;
    if (keepBox && node.metadata.naturalWidth === width && node.metadata.naturalHeight === height) return node;
    const size = keepBox ? { width: node.width, height: node.height } : fitNodeSize(width, height, node.width, node.height);
    return { ...node, ...size, position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 }, metadata: { ...node.metadata, naturalWidth: width, naturalHeight: height } };
}

export function acceptsVideoTaskUpdate(node: CanvasNodeData, startedAt: number, incomingStatus = "processing") {
    if (node.metadata?.startedAt && node.metadata.startedAt !== startedAt) return false;
    if (node.metadata?.status === "error" && !isTaskLookupRetry(node.metadata.errorDetails) && !isTaskTerminal(incomingStatus)) return false;
    return !(node.metadata?.status === "success" && (node.metadata.content || node.metadata.storageKey));
}
