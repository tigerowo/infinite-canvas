"use client";

import { useEffect, useState } from "react";
import type { WorkflowMediaSlotMode, WorkflowRef } from "@/lib/workflow-channel";
import { findWorkflowEntry, normalizeWorkflowMediaSlotModes, workflowMediaSlots, type WorkflowMediaSlot } from "@/lib/workflow-media-slots";
import { listWorkflowChannels } from "@/services/workflow-channel-storage";
import { useUserStore } from "@/stores/use-user-store";

type WorkflowMediaSlotControlProps = {
    slots: WorkflowMediaSlot[];
    modes: Record<string, WorkflowMediaSlotMode>;
    onChange: (modes: Record<string, WorkflowMediaSlotMode>) => void;
};

export function WorkflowMediaSlotControl({ slots, modes, onChange }: WorkflowMediaSlotControlProps) {
    if (!slots.length) return null;
    const active = slots.filter((slot) => modes[slot.id] !== "off").length;
    const setAll = (mode: WorkflowMediaSlotMode) => onChange(Object.fromEntries(slots.map((slot) => [slot.id, mode])));
    return (
        <details className="group mt-2 rounded-xl border border-white/10 bg-black/15 text-xs" onMouseDown={(event) => event.stopPropagation()}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium">
                <span>参考媒体 {active}/{slots.length}</span>
                <span className="text-[10px] opacity-55 group-open:hidden">展开设置</span>
            </summary>
            <div className="border-t border-white/10 p-2">
                <div className="mb-2 flex gap-1.5">
                    <button type="button" className="rounded-md border border-white/10 px-2 py-1 hover:bg-white/10" onClick={() => setAll("off")}>全部关闭</button>
                    <button type="button" className="rounded-md border border-white/10 px-2 py-1 hover:bg-white/10" onClick={() => setAll("canvas")}>全部启用</button>
                </div>
                <div className="grid gap-1.5">
                    {slots.map((slot) => (
                        <label key={slot.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-2 py-1.5">
                            <span className="min-w-0 truncate" title={slot.label}>{slot.label}</span>
                            <select
                                className="h-7 shrink-0 rounded-md border border-white/10 bg-black/25 px-2 text-xs"
                                value={modes[slot.id] || slot.defaultMode}
                                onChange={(event) => onChange({ ...modes, [slot.id]: event.target.value as WorkflowMediaSlotMode })}
                                aria-label={`${slot.label}模式`}
                            >
                                <option value="off">关闭</option>
                                <option value="canvas">画布素材</option>
                                <option value="default">工作流默认</option>
                            </select>
                        </label>
                    ))}
                </div>
            </div>
        </details>
    );
}

export function CanvasWorkflowMediaSlotControl({ workflowRef, modes, onChange }: { workflowRef?: WorkflowRef; modes?: Record<string, WorkflowMediaSlotMode>; onChange: (modes: Record<string, WorkflowMediaSlotMode>) => void }) {
    const accountId = useUserStore((state) => state.user?.id || "guest");
    const [slots, setSlots] = useState<WorkflowMediaSlot[]>([]);
    useEffect(() => {
        let active = true;
        if (!workflowRef || workflowRef.scope !== "personal") {
            setSlots([]);
            return;
        }
        void listWorkflowChannels(accountId).then((channels) => {
            if (active) setSlots(workflowMediaSlots(findWorkflowEntry(channels, workflowRef)));
        });
        return () => { active = false; };
    }, [accountId, workflowRef]);
    return <WorkflowMediaSlotControl slots={slots} modes={normalizeWorkflowMediaSlotModes(slots, modes)} onChange={onChange} />;
}
