"use client";

import { Popover } from "radix-ui";
import { useId, type ReactElement, type ReactNode } from "react";
import { X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import styles from "./glass-ui.module.css";
import { PanelResizeHandle } from "./panel-resize-handle";

export type SettingsPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

// Radix owns collision detection, focus restoration and exit presence for both settings panels.
export function SettingsPopover({ title, trigger, children, placement = "topLeft", width = 360, surface = "glass", onOpenChange }: { title: string; trigger: ReactElement; children: ReactNode; placement?: SettingsPlacement; width?: number; surface?: "glass" | "solid"; onOpenChange?: (open: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const titleId = useId();
    return (
        <Popover.Root onOpenChange={onOpenChange}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    aria-label={title}
                    aria-labelledby={titleId}
                    data-canvas-no-zoom
                    data-resizable-panel
                    className={styles.popover}
                    side={placement.startsWith("top") ? "top" : "bottom"}
                    align={placement.endsWith("Right") ? "end" : placement.endsWith("Left") ? "start" : "center"}
                    sideOffset={10}
                    avoidCollisions
                    collisionPadding={12}
                    sticky="always"
                    updatePositionStrategy="always"
                    style={{ width: `min(${width}px, calc(100vw - 24px))`, resize: "both", minWidth: "min(280px, calc(100vw - 24px))", minHeight: 160, maxWidth: "calc(100vw - 24px)", backgroundColor: theme.glass.panel, borderColor: theme.glass.border, color: theme.node.text, ...(surface === "solid" ? { background: "var(--popover)", backdropFilter: "none", WebkitBackdropFilter: "none" } : {}) }}
                    onInteractOutside={(event) => {
                        // Ant Design select options are portalled to the body.
                        if (event.target instanceof Element && event.target.closest(".ant-select-dropdown, [data-ext-skill-overlay], .ext-skill-editor")) event.preventDefault();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                >
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 id={titleId} className="text-[17px] font-semibold">{title}</h2>
                        <Popover.Close
                            aria-label={`关闭${title}`}
                            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-[var(--glass-control)] transition hover:bg-[var(--glass-active)] focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            <X className="size-4" />
                        </Popover.Close>
                    </div>
                    {children}
                    <PanelResizeHandle />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
