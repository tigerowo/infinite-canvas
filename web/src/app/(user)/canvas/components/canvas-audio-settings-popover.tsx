"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel, type AudioSettingKey } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel, glmTtsVoiceLabel, isGlmTtsModel, normalizeGlmTtsFormat, normalizeGlmTtsSpeed } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsVoiceLabel, normalizeMimoTtsFormat } from "@/lib/mimo-tts";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { ResourceSinglePicker, type CanvasVideoResourceOption } from "./canvas-video-settings-popover";
import type { CanvasNodeMetadata } from "../types";

export type CanvasAudioSettingKey = AudioSettingKey;

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    resourceOptions?: CanvasVideoResourceOption[];
    metadata?: CanvasNodeMetadata;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, resourceOptions = [], metadata, onMetadataChange, buttonClassName, placement = "topLeft" }: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const audioOptions = useMemo(() => resourceOptions.filter((item) => item.kind === "audio"), [resourceOptions]);
    const cloneAudioNodeId = validCloneAudioNodeId(metadata?.mimoVoiceCloneAudioNodeId, audioOptions);
    const panel = open && buttonRect ? <AudioSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} audioOptions={audioOptions} cloneAudioNodeId={cloneAudioNodeId} onMetadataChange={onMetadataChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">{audioSettingsSummary(config, cloneAudioNodeId, audioOptions)}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({ buttonRect, panelRef, placement, theme, config, onConfigChange, audioOptions, cloneAudioNodeId, onMetadataChange }: { buttonRect: DOMRect; panelRef: RefObject<HTMLDivElement | null>; placement: CanvasAudioSettingsPopoverProps["placement"]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; config: AiConfig; onConfigChange: CanvasAudioSettingsPopoverProps["onConfigChange"]; audioOptions: CanvasVideoResourceOption[]; cloneAudioNodeId: string; onMetadataChange?: CanvasAudioSettingsPopoverProps["onMetadataChange"] }) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;
    const model = config.model || config.audioModel || "";

    return createPortal(
        <div ref={panelRef} className="canvas-image-settings-popover" style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="space-y-4">
                <div className="text-lg font-semibold">音频设置</div>
                {isMimoVoiceCloneModel(model) ? (
                    <ResourceSinglePicker
                        label="参考音频"
                        value={cloneAudioNodeId}
                        options={audioOptions}
                        placeholder="请选择音频节点"
                        emptyText={audioOptions.length ? "请选择已连接音频" : "暂无已连接音频节点"}
                        theme={theme}
                        onChange={(value) => onMetadataChange?.({ mimoVoiceCloneAudioNodeId: value || undefined })}
                    />
                ) : null}
                <AudioSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </div>,
        document.body,
    );
}

function validCloneAudioNodeId(value: string | undefined, options: CanvasVideoResourceOption[]) {
    if (value && options.some((item) => item.nodeId === value)) return value;
    return options.length === 1 ? options[0].nodeId : "";
}

function audioSettingsSummary(config: AiConfig, cloneAudioNodeId: string, audioOptions: CanvasVideoResourceOption[]) {
    const model = config.model || config.audioModel || "";
    if (isGlmTtsModel(model)) return `${glmTtsVoiceLabel(config.glmTtsVoice)} · ${normalizeGlmTtsFormat(config.glmTtsFormat).toUpperCase()} · ${normalizeGlmTtsSpeed(config.glmTtsSpeed)}x`;
    if (!isMimoTtsModel(model)) return `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;
    const format = normalizeMimoTtsFormat(config.mimoTtsFormat).toUpperCase();
    if (isMimoPresetTtsModel(model)) return `${mimoTtsVoiceLabel(config.mimoTtsVoice)} · ${format}`;
    if (isMimoVoiceDesignModel(model)) return `音色设计 · ${format}`;
    if (isMimoVoiceCloneModel(model)) return `${audioOptions.find((item) => item.nodeId === cloneAudioNodeId)?.label || "参考音频"} · ${format}`;
    return format;
}
