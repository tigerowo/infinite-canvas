import type { CanvasAssistantSession, CanvasNodeData } from "../types";

function isBlobUrl(value?: string) {
    return Boolean(value && value.startsWith("blob:"));
}

/** Never persist browser-local blob: URLs. They die across reverse-proxy domains/origins. */
export function sanitizeCanvasNodeForPersistence(node: CanvasNodeData): CanvasNodeData {
    const metadata = node.metadata || {};
    const content = metadata.content || "";
    if (!isBlobUrl(content)) return node;
    return {
        ...node,
        metadata: {
            ...metadata,
            // Keep storageKey for same-origin IndexedDB restore; drop dead blob content.
            content: "",
        },
    };
}

export function sanitizeCanvasNodesForPersistence(nodes: CanvasNodeData[] = []) {
    return nodes.map(sanitizeCanvasNodeForPersistence);
}

export function sanitizeCanvasSessionsForPersistence(sessions: CanvasAssistantSession[] = []) {
    return sessions.map((session) => ({
        ...session,
        messages: (session.messages || []).map((message) => ({
            ...message,
            images: (message.images || []).map((image) => ({
                ...image,
                dataUrl: isBlobUrl(image.dataUrl) ? "" : image.dataUrl,
            })),
            references: (message.references || []).map((reference) => ({
                ...reference,
                dataUrl: isBlobUrl(reference.dataUrl) ? "" : reference.dataUrl,
                url: isBlobUrl(reference.url) ? "" : reference.url,
            })),
        })),
    }));
}
