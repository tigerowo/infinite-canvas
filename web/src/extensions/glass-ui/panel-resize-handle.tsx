"use client";

import { useRef } from "react";
import { MoveDiagonal2 } from "lucide-react";

export function PanelResizeHandle() {
    const drag = useRef<{ panel: HTMLElement; x: number; y: number; width: number; height: number } | null>(null);
    const resize = (panel: HTMLElement, width: number, height: number) => {
        panel.style.width = `${Math.min(window.innerWidth - 24, Math.max(280, width))}px`;
        panel.style.height = `${Math.min(window.innerHeight - 24, Math.max(160, height))}px`;
    };
    return (
        <div className="pointer-events-none sticky bottom-0 -mb-1 flex justify-end">
            <button
                type="button"
                aria-label="调整窗口大小"
                title="调整窗口大小"
                className="pointer-events-auto grid size-11 shrink-0 touch-none cursor-nwse-resize place-items-center rounded-lg bg-[var(--glass-control)] text-[var(--glass-accent)] focus-visible:outline-2"
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const panel = event.currentTarget.closest<HTMLElement>("[data-resizable-panel]");
                    if (!panel) return;
                    const rect = panel.getBoundingClientRect();
                    drag.current = { panel, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    if (!drag.current) return;
                    const { panel, x, y, width, height } = drag.current;
                    resize(panel, width + event.clientX - x, height + event.clientY - y);
                }}
                onPointerUp={() => { drag.current = null; }}
                onPointerCancel={() => { drag.current = null; }}
                onLostPointerCapture={() => { drag.current = null; }}
                onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const panel = event.currentTarget.closest<HTMLElement>("[data-resizable-panel]");
                    if (!panel) return;
                    const rect = panel.getBoundingClientRect();
                    const step = event.shiftKey ? 64 : 16;
                    resize(panel, rect.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), rect.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0));
                }}
            ><MoveDiagonal2 className="size-4" /></button>
        </div>
    );
}
