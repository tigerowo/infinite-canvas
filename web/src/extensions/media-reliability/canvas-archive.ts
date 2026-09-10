import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { archiveGeneratedMedia } from "./archive";
import { useUserStore } from "@/stores/use-user-store";

export function useCanvasArchive(nodes: CanvasNodeData[], setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>, warn: (text: string) => unknown) {
    const token = useUserStore((state) => state.token);
    const mountedAt = useRef(Date.now());
    const pending = useRef(new Set<string>());
    const attempted = useRef(new Set<string>());
    useEffect(() => {
        mountedAt.current = Date.now();
        pending.current.clear();
        attempted.current.clear();
    }, [token]);
    useEffect(() => {
        if (!token) return;
        for (const node of nodes) {
            if (![CanvasNodeType.Image, CanvasNodeType.Panorama, CanvasNodeType.Video].includes(node.type)) continue;
            const meta = node.metadata;
            const identity = `${node.id}:${meta?.startedAt || 0}`;
            if (meta?.status === "loading") pending.current.add(identity);
            if (meta?.status !== "success" || !meta.content || meta.storageKey?.startsWith("server:") || attempted.current.has(identity)) continue;
            if (!pending.current.has(identity) && !meta.archivePending && (meta.startedAt || 0) < mountedAt.current) continue;
            attempted.current.add(identity);
            const content = meta.content;
            setNodes((value) => value.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, archivePending: true, archiveError: undefined } } : item));
            void archiveGeneratedMedia(node.type === CanvasNodeType.Video ? "video" : "image", identity, content, meta.storageKey).then((saved) => {
                if (useUserStore.getState().token !== token) return;
                setNodes((value) => value.map((item) => item.id === node.id && item.metadata?.content === content && item.metadata?.startedAt === meta.startedAt ? { ...item, metadata: { ...item.metadata, content: saved.url, storageKey: saved.storageKey, archivePending: false, archiveError: saved.archiveError } } : item));
                if (saved.archiveError) warn("生成完成，云端保存失败。可在节点菜单中重试同步。");
            }).catch(() => { attempted.current.delete(identity); });
        }
    }, [nodes, setNodes, token, warn]);
}
