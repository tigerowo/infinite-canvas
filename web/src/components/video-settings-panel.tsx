"use client";

import { type CSSProperties, type ReactNode } from "react";
import { Input, Switch } from "antd";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceFastOrMiniModel, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceDurationOptions, seedancePixelLabel, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { COGVIDEOX3_DURATIONS, isCogVideoX3Model, modelKey, normalizeCogVideoX3Duration, supportsVideoAudioGeneration } from "@/lib/video-model-capabilities";
import { channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";

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

const secondOptions = [6, 10, 12, 16, 20];
const klingV26ModeOptions = [
    { value: "std", title: "标准模式", desc: "(720P 无声)" },
    { value: "pro", title: "专业模式", desc: "(1080P 音频)" },
] as const;
const klingV3ModeOptions = [
    { value: "std", title: "720P", desc: "" },
    { value: "pro", title: "1080P", desc: "" },
    { value: "4k", title: "4K", desc: "" },
] as const;
const klingV26RatioOptions = seedanceRatioOptions.slice(0, 3);
const klingV26DurationOptions = [5, 10] as const;
const klingV3DurationOptions = [3, 15] as const;
const klingV26RatioLabels: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "960x960",
};

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
    if (isAPIMartKlingV26Config(config, modelName || config.model || config.videoModel) || isAPIMartKlingV3Config(config, modelName || config.model || config.videoModel) || isKIEKlingV3Config(config, modelName || config.model || config.videoModel)) {
        return <KlingV26VideoSettingsPanel config={config} modelName={modelName} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} hideNegativePrompt={hideNegativePrompt} visualOnly={visualOnly} />;
    }
    if (isSeedanceVideoConfig(config)) {
        return <SeedanceVideoSettingsPanel config={config} modelName={modelName} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} visualOnly={visualOnly} />;
    }

    const model = modelName || config.model || config.videoModel;
    const grokMode = config.videoMode === "fun" || config.videoMode === "spicy" ? config.videoMode : "normal";
    const cogVideoX3 = isCogVideoX3Model(model);
    const seconds = cogVideoX3 ? normalizeCogVideoX3Duration(config.videoSeconds) : config.videoSeconds || "6";
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolutionValue(config.vquality);
    const audioGenerationEnabled = supportsVideoAudioGeneration(model);
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
            return Math.abs(candidateWidth * candidateHeight - pixels) < Math.abs(nearestWidth * nearestHeight - pixels)
                ? candidate
                : nearest;
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
                        <ResolutionInput value={resolution} theme={theme} onChange={updateResolution} />
                    </div>
                </SettingGroup>
                <SettingGroup title="尺寸" color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                                style={{
                                    borderColor: normalizeSeedanceRatio(config.size) === item.value
                                        ? theme.node.text
                                        : theme.node.stroke,
                                    color: theme.node.text,
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() =>
                                    onConfigChange(
                                        "size",
                                        item.value === "adaptive"
                                            ? "auto"
                                            : seedancePixelLabel(resolution, item.value),
                                    )
                                }
                            >
                                <SizePreview
                                    width={ratioPreview(item.value).width}
                                    height={ratioPreview(item.value).height}
                                    color={theme.node.text}
                                />
                                <span>{item.label}</span>
                                <span className="text-[10px] leading-none opacity-55">
                                    {item.value === "adaptive"
                                        ? "adaptive"
                                        : seedancePixelLabel(resolution, item.value)}
                                </span>
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
                                {cogVideoX3 ? null : <NumberInput value={seconds} min={1} max={30} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />}
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
                                className="flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-full border bg-transparent px-2 text-sm leading-4 transition hover:opacity-80"
                                style={{ borderColor: mode === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
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
                                className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                                style={{ borderColor: ratio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
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
                                {isV3 ? <NumberInput value={String(duration)} min={3} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} /> : null}
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
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const watermark = boolConfig(config.videoWatermark, false);
    const audioGenerationEnabled = supportsVideoAudioGeneration(model);
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
                                className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                                style={{ borderColor: ratio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
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
                                {seedanceDurationOptions.map((value) => (
                                    <OptionPill key={value} selected={duration === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                        {value === -1 ? "智能" : `${value}s`}
                                    </OptionPill>
                                ))}
                            </div>
                            <NumberInput value={String(duration)} min={-1} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
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
    const presetRatio = seedanceRatioOptions.find((item) =>
        item.value !== "adaptive" && videoResolutionOptions.some((resolution) => seedancePixelLabel(resolution.value, item.value) === value),
    );
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
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
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

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="text" className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            {/^\d{3,}$/.test(value.trim()) ? (
                <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                    p
                </span>
            ) : null}
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
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

export function isAPIMartKlingV26Config(config: AiConfig, modelName: string) {
    return isAPIMartKlingConfig(config, modelName, "kling-v2-6");
}

export function isAPIMartKlingV3Config(config: AiConfig, modelName: string) {
    return isAPIMartKlingConfig(config, modelName, "kling-v3");
}

export function isAPIMartKlingMotionControlConfig(config: AiConfig, modelName: string) {
    return isProviderKlingConfig(config, modelName, "kling-v2-6-motion-control", "apimart");
}

export function isKIEKlingV3Config(config: AiConfig, modelName: string) {
    return isProviderKlingConfig(config, modelName, "kling-3-0-video", "kie") || Boolean(kieKlingOmniVariant(config, modelName));
}

export function kieKlingOmniVariant(config: AiConfig, modelName: string) {
    const key = modelKey(modelName || config.model || config.videoModel);
    const variant = key.startsWith("kling-3-0-omni-") ? key.slice("kling-3-0-omni-".length) : "";
    if (!["text-to-video", "image-to-video", "reference-to-video", "transformation"].includes(variant)) return "";
    return isProviderKlingConfig(config, modelName, key, "kie") ? variant : "";
}

export function isKIEKlingMotionControlConfig(config: AiConfig, modelName: string) {
    return isProviderKlingConfig(config, modelName, "kling-2-6-motion-control", "kie") || isProviderKlingConfig(config, modelName, "kling-3-0-motion-control", "kie");
}

function isAPIMartKlingConfig(config: AiConfig, modelName: string, key: string) {
    return isProviderKlingConfig(config, modelName, key, "apimart");
}

function isProviderKlingConfig(config: AiConfig, modelName: string, key: string, provider: string) {
    const model = modelName || config.model || config.videoModel;
    if (modelKey(model) !== key) return false;
    const scopedConfig = { ...config, model, videoModel: model };
    const channelId = channelIdForActiveModel(scopedConfig);
    const channels = config.channelMode === "remote" ? config.publicChannels : [localChannelForActiveModel(scopedConfig)];
    const channel = channels.find((item) => (item?.id || "") === channelId) || channels[0];
    const record = channel as { id?: string; name?: string; baseUrl?: string; remark?: string } | undefined;
    const text = [record?.id, record?.name, record?.baseUrl, record?.remark].filter(Boolean).join(" ").toLowerCase();
    return text.includes(provider);
}

function normalizeKlingV26Ratio(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["9:16", "720x1280", "1080x1920"].includes(normalized)) return "9:16";
    if (["1:1", "1024x1024", "1080x1080"].includes(normalized)) return "1:1";
    return "16:9";
}

function normalizeKlingV26Duration(value: string) {
    return String(value).trim() === "10" ? 10 : 5;
}

function normalizeKlingV3Duration(value: string) {
    const seconds = Math.floor(Number(value) || 3);
    return Math.max(3, Math.min(15, seconds));
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}

const grokVideoModeOptions = [
    { value: "fun", title: "Fun" },
    { value: "normal", title: "Normal" },
    { value: "spicy", title: "Spicy" },
] as const;

export function isKIEGrokVideoModel(config: AiConfig, modelName: string) {
    const model = (modelName || "").toLowerCase().trim();
    if (model !== "grok-imagine/text-to-video" && model !== "grok-imagine/image-to-video") return false;
    const scopedConfig = { ...config, model, videoModel: model };
    const channelId = channelIdForActiveModel(scopedConfig);
    const channels = config.channelMode === "remote" ? config.publicChannels : [localChannelForActiveModel(scopedConfig)];
    const channel = channels.find((item) => (item?.id || "") === channelId) || channels[0];
    return ((channel as { baseUrl?: string } | undefined)?.baseUrl || "").toLowerCase().includes("kie");
}
