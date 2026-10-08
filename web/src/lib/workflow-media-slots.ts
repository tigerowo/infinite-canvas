import type { WorkflowChannelData, WorkflowEntry, WorkflowMediaSlotMode, WorkflowRef } from "./workflow-channel";

export type WorkflowMediaSlot = {
    id: string;
    mediaType: "image" | "video" | "audio";
    index: number;
    label: string;
    defaultMode: WorkflowMediaSlotMode;
};

export function findWorkflowEntry(_channels: WorkflowChannelData[], _ref: WorkflowRef): WorkflowEntry | undefined {
    return _channels
        .find((channel) => channel.channelId === _ref.channelId)
        ?.workflows.find((entry) => entry.kind === _ref.kind && entry.workflowId === _ref.workflowId);
}

export function workflowMediaSlots(_entry?: WorkflowEntry): WorkflowMediaSlot[] {
    if (!_entry) return [];
    return _entry.fields.flatMap((field): WorkflowMediaSlot[] => {
        if (!field.optionalMedia || !field.mediaPrunePlan?.removeNodeIds.length) return [];
        const mediaType = field.source === "referenceImage" ? "image" : field.source === "referenceVideo" ? "video" : field.source === "referenceAudio" ? "audio" : null;
        if (!mediaType) return [];
        const index = mediaType === "image" && Number(field.imageOrder) > 0 ? Number(field.imageOrder) - 1 : Math.max(0, Number(field.sourceIndex) || 0);
        const noun = mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "音频";
        return [{
            id: `${field.nodeId}::${field.fieldName}`,
            mediaType,
            index,
            label: field.label || `参考${noun} ${index + 1}`,
            defaultMode: isWorkflowMediaSlotMode(field.mediaDefaultMode) ? field.mediaDefaultMode : "canvas",
        }];
    });
}

export function normalizeWorkflowMediaSlotModes(_slots: WorkflowMediaSlot[], _stored?: Record<string, WorkflowMediaSlotMode>): Record<string, WorkflowMediaSlotMode> {
    return Object.fromEntries(_slots.map((slot) => [slot.id, isWorkflowMediaSlotMode(_stored?.[slot.id]) ? _stored?.[slot.id] : slot.defaultMode])) as Record<string, WorkflowMediaSlotMode>;
}

export function bindWorkflowMediaSlots<TImage, TVideo, TAudio>(
    _slots: WorkflowMediaSlot[],
    _modes: Record<string, WorkflowMediaSlotMode>,
    _media: { images: TImage[]; videos: TVideo[]; audios: TAudio[] },
): { images: Array<TImage | undefined>; videos: Array<TVideo | undefined>; audios: Array<TAudio | undefined>; error?: string } {
    const result: { images: Array<TImage | undefined>; videos: Array<TVideo | undefined>; audios: Array<TAudio | undefined>; error?: string } = { images: [], videos: [], audios: [] };
    const positions = { image: 0, video: 0, audio: 0 };
    const sources = { image: _media.images, video: _media.videos, audio: _media.audios };
    const targets = { image: result.images, video: result.videos, audio: result.audios };
    for (const slot of _slots) {
        if (_modes[slot.id] !== "canvas") continue;
        const value = sources[slot.mediaType][positions[slot.mediaType]++];
        if (value === undefined) return { ...result, error: `${slot.label} 已启用，但没有画布素材` };
        targets[slot.mediaType][slot.index] = value;
    }
    return result;
}

function isWorkflowMediaSlotMode(value: unknown): value is WorkflowMediaSlotMode {
    return value === "off" || value === "canvas" || value === "default";
}
