"use client";

import { type CSSProperties, type ReactNode } from "react";
import { Input, Switch } from "antd";
import { isNewAPIConfig } from "@/extensions/newapi/config";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { useAutoDLWorkflow } from "@/hooks/use-autodl-workflow";
import { isAutoDLConfig, normalizeAutoDLDuration } from "@/lib/autodl";
import {
    boolConfig,
    isSeedanceFastOrMiniModel,
    isSeedanceVideoConfig,
    normalizeSeedanceDuration,
    normalizeSeedanceRatio,
    normalizeSeedanceResolution,
    seedanceDurationOptions,
    seedancePixelLabel,
    seedanceRatioOptions,
    seedanceResolutionOptions,
} from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { COGVIDEOX3_DURATIONS, isCogVideoX3Model, modelKey, normalizeCogVideoX3Duration, supportsVideoAudioGeneration } from "@/lib/video-model-capabilities";
import {
    grokVideoModeOptions,
    isAPIMartKlingV26Config,
    isAPIMartKlingV3Config,
    isKIEGrokVideoModel,
    isKIEKlingV3Config,
    klingV26DurationOptions,
    klingV26ModeOptions,
    klingV26RatioLabels,
    klingV26RatioOptions,
    klingV3DurationOptions,
    klingV3ModeOptions,
    normalizeKlingV26Duration,
    normalizeKlingV26Ratio,
    normalizeKlingV3Duration,
} from "@/services/api/protocols/kling-models";
import { channelProtocolForConfig, type AiConfig } from "@/stores/use-config-store";
import styles from "@/extensions/glass-ui/glass-ui.module.css";

export { isAPIMartKlingV26Config, isAPIMartKlingV3Config, isAPIMartKlingMotionControlConfig, isKIEKlingV3Config, kieKlingOmniVariant, isKIEKlingMotionControlConfig, isKIEGrokVideoModel } from "@/services/api/protocols/kling-models";

export const videoResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];
const resolutionButtonOptions = videoResolutionOptions.slice(0, 2);

const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
];

const secondOptions = [6, 10, 12, 15];

type VideoSettingsPanelProps = {
    config: AiConfig;
    modelName?: string;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoMode" | "videoNegativePrompt" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    hideNegativePrompt?: boolean;
    visualOnly?: boolean;
};

export function VideoSettingsPanel({ config, modelName, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", hideNegativePrompt = false, visualOnly = false }: VideoSettingsPanelProps) {
    const model = modelName || config.model || config.videoModel;
    const autodl = isAutoDLConfig(config, model);
    const { data: workflow } = useAutoDLWorkflow(config, model);
    if (isAPIMartKlingV26Config(config, modelName || config.model || config.videoModel) || isAPIMartKlingV3Config(config, modelName || config.model || config.videoModel) || isKIEKlingV3Config(config, modelName || config.model || config.videoModel)) {
        return <KlingV26VideoSettingsPanel config={config} modelName={modelName} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} hideNegativePrompt={hideNegativePrompt} visualOnly={visualOnly} />;
    }
    if (!isNewAPIConfig(config) && !autodl && isSeedanceVideoConfig(config)) {
        return <SeedanceVideoSettingsPanel config={config} modelName={modelName} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} visualOnly={visualOnly} />;
    }

    const grokMode = config.videoMode === "fun" || config.videoMode === "spicy" ? config.videoMode : "normal";
    const cogVideoX3 = !isNewAPIConfig(config) && isCogVideoX3Model(model);
    const seconds = autodl ? config.videoSeconds ?? "" : cogVideoX3 ? normalizeCogVideoX3Duration(config.videoSeconds) : config.videoSeconds || "6";
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolutionValue(config.vquality);
    const selectedRatio = seedanceRatioOptions.find((item) => size === (item.value === "adaptive" ? "auto" : seedancePixelLabel(resolution, item.value)) || size === item.value)?.value;
    const audioGenerationEnabled = !isNewAPIConfig(config) && supportsVideoAudioGeneration(model, channelProtocolForConfig({ ...config, model, videoModel: model }));
    const generateAudio = boolConfig(config.videoGenerateAudio, false);
    const updateResolution = (value: string) => {
        const nextResolution = normalizeVideoResolutionValue(value);
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", videoSizeForResolution(nextResolution, config.size));
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        const pixels = width * height;
        const nearestResolution = ["480", "720", "1080", "2k", "4k"].reduce((nearest, candidate) => {
            const [candidateWidth, candidateHeight] = seedancePixelLabel(candidate, "16:9").split("x").map(Number);
            const [nearestWidth, nearestHeight] = seedancePixelLabel(nearest, "16:9").split("x").map(Number);
            return Math.abs(candidateWidth * candidateHeight - pixels) < Math.abs(nearestWidth * nearestHeight - pixels) ? candidate : nearest;
        });
        onConfigChange("size", `${width}x${height}`);
        onConfigChange("vquality", nearestResolution);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                {!visualOnly && isKIEGrokVideoModel(config, model) ? (
                    <SettingGroup title="模式选择" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {grokVideoModeOptions.map((item) => (
                                <OptionPill key={item.value} selected={grokMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                    {item.title}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                <SettingGroup title="清晰度" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {resolutionButtonOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => updateResolution(item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        <ResolutionInput value={resolution} selected={!resolutionButtonOptions.some((item) => item.value === resolution)} theme={theme} onChange={updateResolution} />
                    </div>
                </SettingGroup>
                <SettingGroup title="尺寸" color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto"} selected={!selectedRatio} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto"} selected={!selectedRatio} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={`${styles.option} flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 px-1 text-sm`}
                                aria-pressed={selectedRatio === item.value}
                                style={{ color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value === "adaptive" ? "auto" : seedancePixelLabel(resolution, item.value))}
                            >
                                <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                <span>{item.label}</span>
                                <span className="text-[10px] leading-none opacity-55">{item.value === "adaptive" ? "adaptive" : seedancePixelLabel(resolution, item.value)}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                {!visualOnly ? (
                    <>
                        <SettingGroup title="秒数" color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {(cogVideoX3 ? COGVIDEOX3_DURATIONS : secondOptions).map((value) => (
                                    <OptionPill key={value} selected={seconds === String(value)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                        {value}s
                                    </OptionPill>
                                ))}
                                {cogVideoX3 ? null : <NumberInput value={seconds} selected={!secondOptions.includes(Number(seconds))} min={1} max={30} theme={theme} onBlur={autodl ? (value) => onConfigChange("videoSeconds", normalizeAutoDLDuration(value, workflow)) : undefined} onChange={(value) => onConfigChange("videoSeconds", value)} />}
                            </div>
                        </SettingGroup>
                        {audioGenerationEnabled ? <AudioGenerationSetting checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function KlingV26VideoSettingsPanel({ config, modelName, onConfigChange, theme, showTitle, className, hideNegativePrompt, visualOnly }: VideoSettingsPanelProps) {
    const isV3 = isAPIMartKlingV3Config(config, modelName || config.model || config.videoModel) || isKIEKlingV3Config(config, modelName || config.model || config.videoModel);
    const mode = isV3 && config.videoMode === "4k" ? "4k" : config.videoMode === "pro" ? "pro" : "std";
    const ratio = normalizeKlingV26Ratio(config.size);
    const duration = isV3 ? normalizeKlingV3Duration(config.videoSeconds) : normalizeKlingV26Duration(config.videoSeconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                {hideNegativePrompt || visualOnly ? null : (
                    <SettingGroup title="负面提示词" color={theme.node.muted}>
                        <Input.TextArea
                            value={config.videoNegativePrompt || ""}
                            placeholder="描述不希望出现在视频中的内容"
                            autoSize={{ minRows: 3, maxRows: 6 }}
                            className="rounded-xl placeholder:!text-[var(--canvas-placeholder)] placeholder:!opacity-55"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text, "--canvas-placeholder": theme.node.placeholder } as CSSProperties}
                            onMouseDown={(event) => event.stopPropagation()}
                            onChange={(event) => onConfigChange("videoNegativePrompt", event.target.value)}
                        />
                    </SettingGroup>
                )}
                <SettingGroup title="模式选择" color={theme.node.muted}>
                    <div className={`grid gap-2.5 ${isV3 ? "grid-cols-3" : "grid-cols-2"}`}>
                        {(isV3 ? klingV3ModeOptions : klingV26ModeOptions).map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={`${styles.option} flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-full px-2 text-sm leading-4`}
                                aria-pressed={mode === item.value}
                                style={{ color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("videoMode", item.value)}
                            >
                                <span>{item.title}</span>
                                <span>{item.desc}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {klingV26RatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={`${styles.option} flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 px-1 text-sm`}
                                aria-pressed={ratio === item.value}
                                style={{ color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                <span>{item.label}</span>
                                <span className="text-[10px] leading-none opacity-55">{klingV26RatioLabels[item.value]}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                {!visualOnly ? (
                    <>
                        <SettingGroup title="时长" color={theme.node.muted}>
                            <div className={`grid gap-2.5 ${isV3 ? "grid-cols-3" : "grid-cols-2"}`}>
                                {(isV3 ? klingV3DurationOptions : klingV26DurationOptions).map((value) => (
                                    <OptionPill key={value} selected={duration === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                        {value}s
                                    </OptionPill>
                                ))}
                                {isV3 ? <NumberInput value={config.videoSeconds} selected={!(klingV3DurationOptions as readonly number[]).includes(duration)} min={3} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} /> : null}
                            </div>
                        </SettingGroup>
                        <AudioGenerationSetting checked={generateAudio} hint={isV3 ? undefined : "仅专业模式，仅一张参考图可用"} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, modelName, onConfigChange, theme, showTitle, className, visualOnly }: VideoSettingsPanelProps) {
    const model = modelName || config.model || config.videoModel;
    const resolution = normalizeSeedanceResolution(config.vquality, model);
    const ratio = normalizeSeedanceRatio(config.size);
    const maxSeconds = modelKey(model).includes("seedance-2-5") ? 30 : 15;
    const duration = normalizeSeedanceDuration(config.videoSeconds, maxSeconds);
    const watermark = boolConfig(config.videoWatermark, false);
    const audioGenerationEnabled = supportsVideoAudioGeneration(model, channelProtocolForConfig({ ...config, model, videoModel: model }));
    const generateAudio = boolConfig(config.videoGenerateAudio, false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                <SettingGroup title="分辨率" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceResolutionOptions.map((item) => {
                            const disabled = item.value === "1080p" && isSeedanceFastOrMiniModel(model);
                            return (
                                <OptionPill key={item.value} selected={resolution === item.value} disabled={disabled} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                    {item.label}
                                </OptionPill>
                            );
                        })}
                    </div>
                    {isSeedanceFastOrMiniModel(model) ? <div className="text-[11px] leading-4 opacity-55">fast / mini 模型不支持 1080p，会自动使用 720p。</div> : null}
                </SettingGroup>
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={`${styles.option} flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 px-1 text-sm`}
                                aria-pressed={ratio === item.value}
                                style={{ color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                <span>{item.label}</span>
                                <span className="text-[10px] leading-none opacity-55">{item.value === "adaptive" ? "adaptive" : seedancePixelLabel(resolution, item.value)}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                {!visualOnly ? (
                    <>
                        <SettingGroup title="时长" color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-2.5">
                                {seedanceDurationOptions
                                    .filter((value) => value <= maxSeconds)
                                    .map((value) => (
                                        <OptionPill key={value} selected={duration === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                            {value === -1 ? "智能" : `${value}s`}
                                        </OptionPill>
                                    ))}
                            </div>
                            <NumberInput value={config.videoSeconds} selected={!(seedanceDurationOptions as readonly number[]).includes(Number(config.videoSeconds))} min={-1} max={maxSeconds} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                        </SettingGroup>
                        {audioGenerationEnabled ? <AudioGenerationSetting checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                        <SettingGroup title="输出" color={theme.node.muted}>
                            <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                                <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                            </div>
                        </SettingGroup>
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    const resolution = normalizeVideoResolutionValue(value);
    return resolution.toLowerCase().endsWith("k") ? resolution : `${resolution}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    if (ratio === value) return seedanceRatioOptions.find((item) => item.value === ratio)?.label || ratio;
    const presetRatio = seedanceRatioOptions.find((item) => item.value !== "adaptive" && videoResolutionOptions.some((resolution) => seedancePixelLabel(resolution.value, item.value) === value));
    if (presetRatio) return presetRatio.label;
    const size = normalizeVideoSizeValue(value);
    return sizeOptions.find((item) => item.value === size)?.label || size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return "智能";
    return `${value || "6"}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

export function videoSizeForResolution(resolution: string, size: string) {
    const ratio = normalizeSeedanceRatio(size);
    if (ratio === "adaptive") return "auto";
    const normalizedResolution = normalizeVideoResolutionValue(resolution);
    if (!videoResolutionOptions.some((item) => item.value === normalizedResolution.toLowerCase())) return normalizeVideoSizeValue(size);
    return seedancePixelLabel(normalizedResolution, ratio);
}

export function videoSizeOptions(resolution: string) {
    const normalizedResolution = normalizeVideoResolutionValue(resolution);
    return seedanceRatioOptions.map((item) => {
        const value = item.value === "adaptive" ? "auto" : seedancePixelLabel(normalizedResolution, item.value);
        return { value, label: value };
    });
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            className={`${styles.option} h-11 cursor-pointer rounded-full px-2 text-sm disabled:cursor-not-allowed disabled:opacity-35`}
            style={{ color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
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

function ResolutionInput({ value, selected, theme, onChange }: { value: string; selected: boolean; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className={`${styles.field} flex h-11 overflow-hidden rounded-full text-sm`} data-selected={selected} style={{ color: theme.node.text }}>
            <input type="text" aria-label="自定义清晰度" className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            {/^\d{3,}$/.test(value.trim()) ? (
                <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                    p
                </span>
            ) : null}
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, selected, theme, onChange }: { prefix: string; value: number; disabled: boolean; selected: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className={`${styles.field} flex h-11 overflow-hidden rounded-xl text-sm`} data-selected={selected} style={{ color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                aria-label={prefix === "W" ? "自定义宽度" : "自定义高度"}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function NumberInput({ value, selected = false, min, max, theme, onChange, onBlur }: { value: string; selected?: boolean; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void; onBlur?: (value: string) => void }) {
    return (
        <input
            type="number"
            min={min}
            max={max}
            aria-label="自定义秒数"
            className={`${styles.field} h-11 rounded-full px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
            data-selected={selected}
            style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => onBlur ? onBlur(event.target.value) : onChange(String(Math.min(max, Math.max(min, Math.round(Number(event.target.value) || min)))))}
            onMouseDown={(event) => event.stopPropagation()}
        />
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function AudioGenerationSetting({ checked, hint, theme, onChange }: { checked: boolean; hint?: string; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <SettingGroup title="音频生成" color={theme.node.muted}>
            <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                <SwitchRow label="是否生成与视频同步的AI音频" checked={checked} theme={theme} onChange={onChange} />
                {hint ? <div className="text-[11px] leading-4 opacity-55">{hint}</div> : null}
            </div>
        </SettingGroup>
    );
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}
