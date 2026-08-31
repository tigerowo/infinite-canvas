"use client";

import { FileText, Image as ImageIcon, Music2, Plus, Video, X } from "lucide-react";
import { Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "../utils/canvas-resource-references";
import type { CanvasNodeData } from "../types";

export function CanvasNodeReferenceBar({ nodeId, connectedNodes, onDisconnect, onStartSelection }: { nodeId: string; connectedNodes: CanvasNodeData[]; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const references = buildAllCanvasResourceReferences(connectedNodes);
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>参考内容</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map((reference) => <ReferenceItem key={reference.id} reference={reference} onRemove={() => onDisconnect?.(reference.nodeId, nodeId)} />)}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title="从画布选择参考节点" onClick={() => onStartSelection?.(nodeId)}>
                    <Plus className="size-4" />
                </button>
            </div>
        </div>
    );
}

function ReferenceItem({ reference, onRemove }: { reference: CanvasResourceReference; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const Icon = reference.kind === "image" ? ImageIcon : reference.kind === "video" ? Video : reference.kind === "audio" ? Music2 : FileText;
    const isMedia = reference.kind === "image" || reference.kind === "video";
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview reference={reference} />} arrow={!isMedia} destroyOnHidden={reference.kind === "video"} styles={isMedia ? { container: { padding: 0, background: "transparent", boxShadow: "none" } } : undefined}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" className="size-full object-cover" /> : reference.kind === "video" && reference.previewUrl ? <video src={reference.previewUrl} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label="断开参考连接" title="断开参考连接" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt={reference.title} className="block max-h-52 max-w-72 rounded-lg object-contain" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="block max-h-52 max-w-72 rounded-lg" autoPlay muted playsInline preload="metadata" />;
    if (reference.kind === "audio" && reference.previewUrl) return <audio src={reference.previewUrl} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{reference.text || reference.title || "暂无内容"}</div>;
}
