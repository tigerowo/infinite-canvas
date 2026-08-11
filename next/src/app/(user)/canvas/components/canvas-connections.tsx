import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

export function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
    // active 连线用蓝色电流（与节点选中边框 selectionBlue 一致），非 active 用主题 muted 色
    const activeColor = "#2f80ff";

    return (
        <g style={{ ["--canvas-active-stroke" as string]: activeColor }}>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                d={pathD}
                stroke={active ? activeColor : theme.node.muted}
                strokeWidth={active ? 2.5 : 2}
                strokeOpacity={active ? 0.35 : 0.82}
                fill="none"
                style={{
                    pointerEvents: "none",
                }}
            />
            {active ? (
                <path
                    d={pathD}
                    stroke={activeColor}
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray="6,14"
                    style={{
                        filter: `drop-shadow(0 0 6px ${activeColor}66)`,
                        pointerEvents: "none",
                        animation: "canvas-connection-flow 1.2s linear infinite",
                    }}
                />
            ) : null}
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return (
        <g style={{ ["--canvas-active-stroke" as string]: "#2f80ff" }}>
            <path
                d={pathD}
                stroke="#2f80ff"
                strokeWidth="2.5"
                fill="none"
                strokeDasharray="6,14"
                strokeLinecap="round"
                style={{
                    filter: `drop-shadow(0 0 6px #2f80ff66)`,
                    animation: "canvas-connection-flow 1.2s linear infinite",
                }}
            />
        </g>
    );
}
