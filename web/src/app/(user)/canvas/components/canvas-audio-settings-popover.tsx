"use client";
import { isNewAPIConfig } from "@/extensions/newapi/config";

import { useMemo } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel, type AudioSettingKey } from "@/components/audio-settings-panel";
import { isAutoDLConfig } from "@/lib/autodl";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel, glmTtsVoiceLabel, isGlmTtsModel, normalizeGlmTtsFormat, normalizeGlmTtsSpeed } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { isGrok2APITtsConfig, normalizeGrokTtsFormat, normalizeGrokTtsLanguage, normalizeGrokTtsSpeed } from "@/lib/grok-tts";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsVoiceLabel, normalizeMimoTtsFormat } from "@/lib/mimo-tts";
import { isGeminiConfig, isGeminiTtsModel } from "@/lib/gemini";
import { normalizeGeminiTtsVoice } from "@/lib/gemini-tts";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { ResourceSinglePicker, type CanvasVideoResourceOption } from "./canvas-video-settings-popover";
import type { CanvasNodeMetadata } from "../types";
import { SettingsPopover } from "@/extensions/glass-ui/settings-popover";
import styles from "@/extensions/glass-ui/glass-ui.module.css";

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
    const audioOptions = useMemo(() => resourceOptions.filter((item) => item.kind === "audio"), [resourceOptions]);
    const cloneAudioNodeId = validCloneAudioNodeId(isAutoDLConfig(config) ? metadata?.referenceAudioNodeId : metadata?.mimoVoiceCloneAudioNodeId, audioOptions);

    return (
        <SettingsPopover
            title="音频设置"
            placement={placement}
            trigger={
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"}
                    style={{ minHeight: 44, background: theme.glass.panel, color: theme.node.text, borderColor: theme.glass.border }}
                    icon={<Settings2 className="size-3.5" />}
                >
                    <span className="truncate">{audioSettingsSummary(config, cloneAudioNodeId, audioOptions)}</span>
                </Button>
            }
        >
            <div className={styles.settings}>
                <AudioSettingsContent theme={theme} config={config} onConfigChange={onConfigChange} audioOptions={audioOptions} cloneAudioNodeId={cloneAudioNodeId} onMetadataChange={onMetadataChange} />
            </div>
        </SettingsPopover>
    );
}

function AudioSettingsContent({
    theme,
    config,
    onConfigChange,
    audioOptions,
    cloneAudioNodeId,
    onMetadataChange,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: CanvasAudioSettingsPopoverProps["onConfigChange"];
    audioOptions: CanvasVideoResourceOption[];
    cloneAudioNodeId: string;
    onMetadataChange?: CanvasAudioSettingsPopoverProps["onMetadataChange"];
}) {
    const model = config.model || config.audioModel || "";

    return (
        <div className="space-y-4">
            {!isNewAPIConfig(config) && (isMimoVoiceCloneModel(model) || isAutoDLConfig(config, model)) ? (
                <ResourceSinglePicker
                    label="参考音频"
                    value={cloneAudioNodeId}
                    options={audioOptions}
                    placeholder="请选择音频节点"
                    emptyText={audioOptions.length ? "请选择已连接音频" : "暂无已连接音频节点"}
                    theme={theme}
                    onChange={(value) => onMetadataChange?.(isAutoDLConfig(config, model) ? { referenceAudioNodeId: value || undefined } : { mimoVoiceCloneAudioNodeId: value || undefined })}
                />
            ) : null}
            <AudioSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={false} className="space-y-4" />
        </div>
    );
}

function validCloneAudioNodeId(value: string | undefined, options: CanvasVideoResourceOption[]) {
    if (value && options.some((item) => item.nodeId === value)) return value;
    return options.length === 1 ? options[0].nodeId : "";
}

function audioSettingsSummary(config: AiConfig, cloneAudioNodeId: string, audioOptions: CanvasVideoResourceOption[]) {
    if (isNewAPIConfig(config)) return `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;
    const model = config.model || config.audioModel || "";
    if (isGeminiTtsModel(model) && isGeminiConfig(config, model)) return normalizeGeminiTtsVoice(config.geminiTtsVoice);
    if (isGlmTtsModel(model)) return `${glmTtsVoiceLabel(config.glmTtsVoice)} · ${normalizeGlmTtsFormat(config.glmTtsFormat).toUpperCase()} · ${normalizeGlmTtsSpeed(config.glmTtsSpeed)}x`;
    if (isGrok2APITtsConfig(config, model)) return `${config.grokTtsVoice || "eve"} · ${normalizeGrokTtsLanguage(config.grokTtsLanguage)} · ${normalizeGrokTtsFormat(config.grokTtsFormat).toUpperCase()} · ${normalizeGrokTtsSpeed(config.grokTtsSpeed)}x`;
    if (!isMimoTtsModel(model)) return `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;
    const format = normalizeMimoTtsFormat(config.mimoTtsFormat).toUpperCase();
    if (isMimoPresetTtsModel(model)) return `${mimoTtsVoiceLabel(config.mimoTtsVoice)} · ${format}`;
    if (isMimoVoiceDesignModel(model)) return `音色设计 · ${format}`;
    if (isMimoVoiceCloneModel(model)) return `${audioOptions.find((item) => item.nodeId === cloneAudioNodeId)?.label || "参考音频"} · ${format}`;
    return format;
}
