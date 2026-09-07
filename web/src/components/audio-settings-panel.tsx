"use client";

import { Select } from "antd";
import { isNewAPIConfig } from "@/extensions/newapi/config";
import { type ReactNode } from "react";

import { GrokTtsVoiceSelect } from "@/components/grok-tts-voice-select";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, glmTtsFormatOptions, glmTtsVoiceOptions, isGlmTtsModel, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { grokTtsFormatOptions, grokTtsLanguageOptions, isGrok2APITtsConfig, normalizeGrokTtsFormat, normalizeGrokTtsLanguage, normalizeGrokTtsSpeed } from "@/lib/grok-tts";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsFormatOptions, mimoTtsVoiceOptions, normalizeMimoTtsFormat, normalizeMimoTtsVoice } from "@/lib/mimo-tts";
import { isGeminiConfig, isGeminiTtsModel } from "@/lib/gemini";
import { geminiTtsVoiceOptions, normalizeGeminiTtsVoice } from "@/lib/gemini-tts";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

export type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions" | "grokTtsVoice" | "grokTtsLanguage" | "grokTtsFormat" | "grokTtsSpeed" | "glmTtsVoice" | "glmTtsFormat" | "glmTtsSpeed" | "mimoTtsVoice" | "mimoTtsFormat" | "mimoVoiceDesignPrompt" | "geminiTtsVoice";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const model = config.model || config.audioModel || "";
    const grok = isGrok2APITtsConfig(config, model);
    const gemini = isGeminiTtsModel(model) && isGeminiConfig(config, model);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {gemini ? <GeminiAudioSettings config={config} onConfigChange={onConfigChange} theme={theme} /> : !isNewAPIConfig(config) && isMimoTtsModel(model) ? <MiMoAudioSettings config={config} model={model} onConfigChange={onConfigChange} theme={theme} /> : <AudioSpeechSettings config={config} model={model} glm={!isNewAPIConfig(config) && isGlmTtsModel(model)} grok={grok} onConfigChange={onConfigChange} theme={theme} />}
            </div>
        </ImageSettingsTheme>
    );
}

function GeminiAudioSettings({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: AudioSettingsPanelProps["onConfigChange"]; theme: CanvasTheme }) {
    return (
        <SettingGroup title="声音" color={theme.node.muted}>
            <Select className="w-full" showSearch optionFilterProp="label" value={normalizeGeminiTtsVoice(config.geminiTtsVoice)} options={geminiTtsVoiceOptions} onChange={(value) => onConfigChange("geminiTtsVoice", value)} />
        </SettingGroup>
    );
}

function MiMoAudioSettings({ config, model, onConfigChange, theme }: { config: AiConfig; model: string; onConfigChange: AudioSettingsPanelProps["onConfigChange"]; theme: CanvasTheme }) {
    const format = normalizeMimoTtsFormat(config.mimoTtsFormat);

    return (
        <>
            {isMimoPresetTtsModel(model) ? (
                <SettingGroup title="声音" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mimoTtsVoiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={normalizeMimoTtsVoice(config.mimoTtsVoice) === item.value} theme={theme} onClick={() => onConfigChange("mimoTtsVoice", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
            ) : null}
            {isMimoVoiceDesignModel(model) ? (
                <SettingGroup title="音色描述" color={theme.node.muted}>
                    <textarea
                        value={config.mimoVoiceDesignPrompt || ""}
                        placeholder="例如：年轻女性，声音清亮自然，有亲和力。"
                        className="thin-scrollbar h-24 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("mimoVoiceDesignPrompt", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            ) : null}
            <SettingGroup title="格式" color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2.5">
                    {mimoTtsFormatOptions.map((item) => (
                        <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("mimoTtsFormat", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            {isMimoPresetTtsModel(model) || isMimoVoiceCloneModel(model) ? (
                <SettingGroup title="声音指令" color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder="例如：语速轻快，语气兴奋，结尾略微上扬。"
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            ) : null}
        </>
    );
}

function AudioSpeechSettings({ config, model, glm, grok, onConfigChange, theme }: { config: AiConfig; model: string; glm: boolean; grok: boolean; onConfigChange: AudioSettingsPanelProps["onConfigChange"]; theme: CanvasTheme }) {
    const voice = glm ? normalizeGlmTtsVoice(config.glmTtsVoice) : grok ? config.grokTtsVoice || "eve" : normalizeAudioVoiceValue(config.audioVoice);
    const format = glm ? normalizeGlmTtsFormat(config.glmTtsFormat) : grok ? normalizeGrokTtsFormat(config.grokTtsFormat) : normalizeAudioFormatValue(config.audioFormat);
    const speed = glm ? normalizeGlmTtsSpeed(config.glmTtsSpeed) : grok ? normalizeGrokTtsSpeed(config.grokTtsSpeed) : normalizeAudioSpeedValue(config.audioSpeed);
    const voiceOptions = glm ? glmTtsVoiceOptions : audioVoiceOptions;
    const formatOptions = glm ? glmTtsFormatOptions : grok ? grokTtsFormatOptions : audioFormatOptions;
    const voiceKey: AudioSettingKey = glm ? "glmTtsVoice" : "audioVoice";
    const formatKey: AudioSettingKey = glm ? "glmTtsFormat" : grok ? "grokTtsFormat" : "audioFormat";
    const speedKey: AudioSettingKey = glm ? "glmTtsSpeed" : grok ? "grokTtsSpeed" : "audioSpeed";

    return (
        <>
            <SettingGroup title="声音" color={theme.node.muted}>
                {grok ? <GrokTtsVoiceSelect config={config} model={model} value={voice} onChange={(value) => onConfigChange("grokTtsVoice", value)} /> : (
                    <div className="grid grid-cols-3 gap-2.5">
                        {voiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange(voiceKey, item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                )}
            </SettingGroup>
            {grok ? (
                <SettingGroup title="语言" color={theme.node.muted}>
                    <Select className="w-full" value={normalizeGrokTtsLanguage(config.grokTtsLanguage)} options={grokTtsLanguageOptions} showSearch optionFilterProp="label" onChange={(value) => onConfigChange("grokTtsLanguage", value)} />
                </SettingGroup>
            ) : null}
            <SettingGroup title="格式" color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2.5">
                    {formatOptions.map((item) => (
                        <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange(formatKey, item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title="语速" color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2.5">
                    {speedOptions.map((value) => (
                        <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange(speedKey, value)}>
                            {audioSpeedLabel(value)}
                        </OptionPill>
                    ))}
                </div>
                <input
                    type="number"
                    min={glm ? 0.5 : grok ? 0.7 : 0.25}
                    max={glm ? 2 : grok ? 1.5 : 4}
                    step={0.05}
                    className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                    value={(glm ? config.glmTtsSpeed : grok ? config.grokTtsSpeed : config.audioSpeed) || "1"}
                    onChange={(event) => onConfigChange(speedKey, event.target.value)}
                    onBlur={(event) => onConfigChange(speedKey, glm ? normalizeGlmTtsSpeed(event.target.value) : grok ? normalizeGrokTtsSpeed(event.target.value) : normalizeAudioSpeedValue(event.target.value))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
            {!glm && !grok ? (
                <SettingGroup title="声音指令" color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder="例如：自然、温暖、适合旁白。"
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            ) : null}
        </>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
