"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import styles from "@/extensions/glass-ui/glass-ui.module.css";

export function PromptFilterPill({
    active,
    children,
    onClick,
    action = false,
    ariaControls,
    expanded,
}: {
    active?: boolean;
    children: ReactNode;
    onClick: () => void;
    action?: boolean;
    ariaControls?: string;
    expanded?: boolean;
}) {
    return (
        <button
            type="button"
            aria-pressed={action ? undefined : active}
            aria-expanded={action ? expanded : undefined}
            aria-controls={ariaControls}
            className={cn(styles.filterPill, active && styles.filterPillActive, action && styles.filterPillAction)}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
