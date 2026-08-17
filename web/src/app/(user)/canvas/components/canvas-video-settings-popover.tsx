"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Music2, Plus, Settings2, Trash2, Video as VideoIcon, X } from "lucide-react";
import { Button, Input, Switch } from "antd";

import { VideoSettingsPanel, isAPIMartKlingMotionControlConfig, isKIEKlingMotionControlConfig, isAPIMartKlingV3Config, isKIEKlingV3Config, kieKlingOmniVariant, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { supportsVideoFrameReferences } from "@/lib/video-model-capabilities";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "../types";

export type CanvasVideoFrameOption = { nodeId: string; label: string; previewUrl?: string };
export type CanvasVideoResourceOption = { nodeId: string; kind: "text" | "image" | "video" | "audio"; label: string; previewUrl?: string; text?: string };

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoMode" | "videoNegativePrompt" | "videoGenerateAudio" | "videoWatermark" | "videoCharacterOrientation", value: string) => void;
    frameOptions?: CanvasVideoFrameOption[];
    resourceOptions?: CanvasVideoResourceOption[];
    metadata?: CanvasNodeMetadata;
    firstFrameNodeId?: string;
    lastFrameNodeId?: string;
    onFrameChange?: (patch: { firstFrameNodeId?: string; lastFrameNodeId?: string }) => void;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    buttonClassName?: string;
    buttonIcon?: ReactNode;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    visualOnly?: boolean;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, frameOptions = [], resourceOptions = [], metadata, firstFrameNodeId, lastFrameNodeId, onFrameChange, onMetadataChange, buttonClassName, buttonIcon, placement = "topLeft", visualOnly = false }: CanvasVideoSettingsPopoverProps) {
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
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
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

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} frameOptions={frameOptions} resourceOptions={resourceOptions} metadata={metadata} firstFrameNodeId={firstFrameNodeId} lastFrameNodeId={lastFrameNodeId} onFrameChange={onFrameChange} onMetadataChange={onMetadataChange} visualOnly={visualOnly} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={buttonIcon || <Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)}
                        {visualOnly ? null : <> · {videoSecondsLabel(config.videoSeconds)}</>}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({ buttonRect, panelRef, placement, theme, config, onConfigChange, frameOptions, resourceOptions, metadata, firstFrameNodeId, lastFrameNodeId, onFrameChange, onMetadataChange, visualOnly }: { buttonRect: DOMRect; panelRef: RefObject<HTMLDivElement | null>; placement: CanvasVideoSettingsPopoverProps["placement"]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; config: AiConfig; onConfigChange: CanvasVideoSettingsPopoverProps["onConfigChange"]; frameOptions: CanvasVideoFrameOption[]; resourceOptions: CanvasVideoResourceOption[]; metadata?: CanvasNodeMetadata; firstFrameNodeId?: string; lastFrameNodeId?: string; onFrameChange?: CanvasVideoSettingsPopoverProps["onFrameChange"]; onMetadataChange?: CanvasVideoSettingsPopoverProps["onMetadataChange"]; visualOnly: boolean }) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = { position: "fixed", zIndex: 1200, width, left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)), ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }), background: theme.toolbar.panel, borderRadius: 18, boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)", padding: 18, overflowY: "auto", color: theme.node.text } as const;
    const model = config.model || config.videoModel || "";
    const isAPIMartKlingV3 = isAPIMartKlingV3Config(config, model);
    const isKIEKlingV3 = isKIEKlingV3Config(config, model);
    const kieKlingOmni = kieKlingOmniVariant(config, model);
    const isKlingMotionControl = isAPIMartKlingMotionControlConfig(config, model) || isKIEKlingMotionControlConfig(config, model);
    const isKlingV3 = isAPIMartKlingV3 || isKIEKlingV3;
    const frameReferencesEnabled = !isKlingV3 && supportsVideoFrameReferences(model);
    const optionIds = useMemo(() => new Set(frameOptions.map((item) => item.nodeId)), [frameOptions]);
    const firstFrameValue = firstFrameNodeId && optionIds.has(firstFrameNodeId) ? firstFrameNodeId : "";
    const lastFrameValue = lastFrameNodeId && optionIds.has(lastFrameNodeId) ? lastFrameNodeId : "";

    return createPortal(
        <div ref={panelRef} className="canvas-image-settings-popover" style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="space-y-4">
                <div className="text-lg font-semibold">视频设置</div>
                {!visualOnly && isKlingMotionControl ? <CharacterOrientationSetting value={config.videoCharacterOrientation} theme={theme} onChange={(value) => onConfigChange("videoCharacterOrientation", value)} /> : null}
                {!visualOnly && isKlingV3 ? <KlingV3AdvancedSettings config={config} metadata={metadata} resourceOptions={resourceOptions} theme={theme} isKIEKlingV3={isKIEKlingV3} kieKlingOmni={kieKlingOmni} onConfigChange={onConfigChange} onMetadataChange={onMetadataChange} /> : null}
                {!visualOnly && frameReferencesEnabled ? (
                    <CanvasSettingGroup title="首尾帧" color={theme.node.muted}>
                        <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                            <FrameReferencePicker label="首帧" value={firstFrameValue} options={frameOptions} theme={theme} onChange={(value) => onFrameChange?.({ firstFrameNodeId: value || undefined })} />
                            <FrameReferencePicker label="尾帧" value={lastFrameValue} options={frameOptions} theme={theme} onChange={(value) => onFrameChange?.({ lastFrameNodeId: value || undefined })} />
                        </div>
                    </CanvasSettingGroup>
                ) : null}
                <VideoSettingsPanel config={config} modelName={visualOnly ? config.videoModel || config.model : undefined} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} showTitle={false} className="space-y-4" hideNegativePrompt={isKlingV3} visualOnly={visualOnly} />
            </div>
        </div>,
        document.body,
    );
}

function CharacterOrientationSetting({ value, theme, onChange }: { value?: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: string) => void }) {
    const current = value === "image" ? "image" : "video";
    return (
        <CanvasSettingGroup title="角色朝向参考" color={theme.node.muted}>
            <div className="grid grid-cols-2 gap-2.5">
                <OptionPill selected={current === "image"} theme={theme} onClick={() => onChange("image")}>图片</OptionPill>
                <OptionPill selected={current === "video"} theme={theme} onClick={() => onChange("video")}>视频</OptionPill>
            </div>
        </CanvasSettingGroup>
    );
}

function KlingV3AdvancedSettings({ config, metadata, resourceOptions, theme, isKIEKlingV3, kieKlingOmni, onConfigChange, onMetadataChange }: { config: AiConfig; metadata?: CanvasNodeMetadata; resourceOptions: CanvasVideoResourceOption[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; isKIEKlingV3: boolean; kieKlingOmni: string; onConfigChange: CanvasVideoSettingsPopoverProps["onConfigChange"]; onMetadataChange?: CanvasVideoSettingsPopoverProps["onMetadataChange"] }) {
    const multiShot = boolValue(metadata?.multiShot);
    const shotType = metadata?.shotType === "customize" ? "customize" : "intelligence";
    const multiPrompt = normalizeKlingMultiPrompt(metadata?.klingMultiPrompt);
    const imageNodeIds = normalizeNodeIds(metadata?.klingImageNodeIds, 2);
    const elementList = normalizeKlingElementList(metadata?.klingElementList);
    const textOptions = resourceOptions.filter((item) => item.kind === "text");
    const imageOptions = resourceOptions.filter((item) => item.kind === "image");
    const mediaOptions = resourceOptions.filter((item) => item.kind === "image" || item.kind === "video" || item.kind === "audio");
    const supportsMultiShot = kieKlingOmni !== "transformation";
    const supportsSmartShots = !isKIEKlingV3 || kieKlingOmni === "text-to-video" || kieKlingOmni === "image-to-video";
    const showsFrameReferences = !kieKlingOmni || kieKlingOmni === "image-to-video";
    const showsElements = kieKlingOmni !== "transformation";
    const updateMultiPrompt = (items: { textNodeId?: string; duration?: string }[]) => onMetadataChange?.({ klingMultiPrompt: normalizeKlingMultiPrompt(items) });
    const updateElementList = (items: { name?: string; description?: string; nodeIds?: string[] }[]) => onMetadataChange?.({ klingElementList: normalizeKlingElementList(items) });

    return (
        <>
            {supportsMultiShot ? <CanvasSettingGroup title="多镜头分镜" color={theme.node.muted}>
                <div className="grid gap-1 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                    <SwitchRow label="多镜头分镜" hint="是否启用多镜头分镜模式" checked={multiShot} theme={theme} onChange={(checked) => onMetadataChange?.(supportsSmartShots ? { multiShot: String(checked), shotType: checked ? shotType : "intelligence" } : { multiShot: String(checked) })} />
                </div>
            </CanvasSettingGroup> : null}
            {multiShot && supportsSmartShots ? (
                <CanvasSettingGroup title="分镜模式" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        <OptionPill selected={shotType === "customize"} theme={theme} onClick={() => onMetadataChange?.({ shotType: "customize" })}>自定义</OptionPill>
                        <OptionPill selected={shotType === "intelligence"} theme={theme} onClick={() => onMetadataChange?.({ shotType: "intelligence" })}>智能分镜</OptionPill>
                    </div>
                </CanvasSettingGroup>
            ) : null}
            {!isKIEKlingV3 ? <CanvasSettingGroup title="负面提示词" color={theme.node.muted}>
                <Input.TextArea value={config.videoNegativePrompt || ""} placeholder="描述不希望出现在视频中的内容" autoSize={{ minRows: 3, maxRows: 6 }} className="rounded-xl placeholder:!text-[var(--canvas-placeholder)] placeholder:!opacity-55" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text, "--canvas-placeholder": theme.node.placeholder } as CSSProperties} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => onConfigChange("videoNegativePrompt", event.target.value)} />
            </CanvasSettingGroup> : null}
            {supportsMultiShot && multiShot && (!supportsSmartShots || shotType === "customize") ? <KlingMultiPromptSection items={multiPrompt} options={textOptions} theme={theme} onChange={updateMultiPrompt} /> : null}
            {showsFrameReferences ? <CanvasSettingGroup title="首尾帧" color={theme.node.muted}>
                <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                    <ResourceSinglePicker label="首帧" value={imageNodeIds[0] || ""} options={imageOptions} placeholder="不指定" emptyText="暂无已连接图片" theme={theme} onChange={(value) => onMetadataChange?.({ klingImageNodeIds: [value, imageNodeIds[1]].filter(Boolean) })} />
                    <ResourceSinglePicker label="尾帧" value={imageNodeIds[1] || ""} options={imageOptions} placeholder="不指定" emptyText="暂无已连接图片" theme={theme} onChange={(value) => onMetadataChange?.({ klingImageNodeIds: [imageNodeIds[0], value].filter(Boolean) })} />
                </div>
            </CanvasSettingGroup> : null}
            {showsElements ? <KlingElementListSection items={elementList} options={mediaOptions} theme={theme} onChange={updateElementList} /> : null}
        </>
    );
}

function KlingMultiPromptSection({ items, options, theme, onChange }: { items: { textNodeId?: string; duration?: string }[]; options: CanvasVideoResourceOption[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (items: { textNodeId?: string; duration?: string }[]) => void }) {
    const update = (index: number, patch: Partial<{ textNodeId?: string; duration?: string }>) => onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
    return (
        <CanvasSettingGroup title="分镜提示词" color={theme.node.muted}>
            <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                {items.map((item, index) => (
                    <div key={index} className="grid gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">分镜提示词{index + 1}</span>
                            <div className="flex items-center gap-1.5">
                                <NumberField value={item.duration || "1"} min={1} max={15} theme={theme} onChange={(value) => update(index, { duration: value })} />
                                <IconButton title="新增分镜提示词" theme={theme} onClick={() => onChange([...items, { textNodeId: "", duration: "1" }])}><Plus className="size-3.5" /></IconButton>
                                <IconButton title="删除分镜提示词" disabled={items.length <= 1} danger theme={theme} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-3.5" /></IconButton>
                            </div>
                        </div>
                        <ResourceSinglePicker value={item.textNodeId || ""} options={options} placeholder="请选择文字节点" emptyText="暂无已连接文字节点" theme={theme} onChange={(value) => update(index, { textNodeId: value })} />
                    </div>
                ))}
            </div>
        </CanvasSettingGroup>
    );
}

function KlingElementListSection({ items, options, theme, onChange }: { items: { name?: string; description?: string; nodeIds?: string[] }[]; options: CanvasVideoResourceOption[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (items: { name?: string; description?: string; nodeIds?: string[] }[]) => void }) {
    const update = (index: number, patch: Partial<{ name?: string; description?: string; nodeIds?: string[] }>) => onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
    return (
        <CanvasSettingGroup title="元素列表" color={theme.node.muted}>
            <div className="grid gap-3">
                {items.map((item, index) => (
                    <div key={index} className="rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                            <div className="flex items-center gap-2"><span className="text-sm font-medium">元素列表{index + 1}</span><span className="rounded-md px-1.5 py-0.5 text-xs" style={{ background: theme.node.fill }}>{item.nodeIds?.length || 0}</span></div>
                            <div className="flex items-center gap-1.5"><IconButton title="新增元素" disabled={items.length >= 3} theme={theme} onClick={() => onChange([...items, { name: "", description: "", nodeIds: [] }])}><Plus className="size-3.5" /></IconButton><IconButton title="删除元素" disabled={items.length <= 1} danger theme={theme} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-3.5" /></IconButton></div>
                        </div>
                        <div className="grid gap-2 p-2.5">
                            <Input value={item.name || ""} placeholder="元素名称，在提示词中使用@前缀引用" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => update(index, { name: event.target.value })} />
                            <Input value={item.description || ""} placeholder="元素描述" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => update(index, { description: event.target.value })} />
                            <MultiResourcePicker values={item.nodeIds || []} options={options} theme={theme} onChange={(nodeIds) => update(index, { nodeIds })} />
                        </div>
                    </div>
                ))}
            </div>
        </CanvasSettingGroup>
    );
}

function FrameReferencePicker({ label, value, options, theme, onChange }: { label: string; value: string; options: CanvasVideoFrameOption[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: string) => void }) {
    const [open, setOpen] = useState(false);
    const selected = options.find((item) => item.nodeId === value);
    const items = [{ nodeId: "", label: "不指定" }, ...options];
    return <div className="relative grid gap-1.5 text-xs" style={{ color: theme.node.muted }}><div>{label}</div><button type="button" className="flex h-12 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-xl border px-2 text-left transition hover:opacity-90" style={{ background: theme.node.fill, borderColor: open ? theme.toolbar.activeText : theme.node.stroke, color: theme.node.text }} onClick={() => setOpen((current) => !current)}><FramePreview option={selected} /><span className="min-w-0 flex-1 overflow-hidden"><span className="block truncate font-medium">{selected?.label || "不指定"}</span><span className="block truncate opacity-55">{selected ? "已连接图片节点" : options.length ? "点击选择已连接图片" : "暂无已连接图片"}</span></span>{selected ? <ClearButton onClick={() => onChange("")} /> : null}</button>{open ? <PickerMenu items={items} value={value} theme={theme} renderPreview={(item) => <FramePreview option={item.nodeId ? item : undefined} />} renderTitle={(item) => item.label} renderSubtitle={(item) => (item.nodeId ? "已连接图片节点" : "不使用首尾帧图片")} onSelect={(nodeId) => { onChange(nodeId); setOpen(false); }} /> : null}</div>;
}

export function ResourceSinglePicker({ label, value, options, placeholder, emptyText, theme, onChange }: { label?: string; value: string; options: CanvasVideoResourceOption[]; placeholder: string; emptyText: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: string) => void }) {
    const [open, setOpen] = useState(false);
    const selected = options.find((item) => item.nodeId === value);
    const items = [{ nodeId: "", kind: "text" as const, label: placeholder }, ...options];
    return <div className="relative grid gap-1.5 text-xs" style={{ color: theme.node.muted }}>{label ? <div>{label}</div> : null}<button type="button" className="flex h-14 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-xl border px-2 text-left transition hover:opacity-90" style={{ background: theme.node.fill, borderColor: open ? theme.toolbar.activeText : theme.node.stroke, color: theme.node.text }} onClick={() => setOpen((current) => !current)}><ResourcePreview option={selected} theme={theme} /><span className="min-w-0 flex-1 overflow-hidden"><span className="block truncate font-medium">{selected ? optionTitle(selected) : placeholder}</span><span className="block truncate opacity-55">{selected ? optionSubtitle(selected) : emptyText}</span></span>{selected ? <ClearButton onClick={() => onChange("")} /> : null}</button>{open ? <PickerMenu items={items} value={value} theme={theme} renderPreview={(item) => <ResourcePreview option={item.nodeId ? item : undefined} theme={theme} />} renderTitle={(item) => (item.nodeId ? optionTitle(item) : placeholder)} renderSubtitle={(item) => (item.nodeId ? optionSubtitle(item) : emptyText)} onSelect={(nodeId) => { onChange(nodeId); setOpen(false); }} /> : null}</div>;
}

function MultiResourcePicker({ values, options, theme, onChange }: { values: string[]; options: CanvasVideoResourceOption[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (values: string[]) => void }) {
    const [open, setOpen] = useState(false);
    const selected = values.map((nodeId) => options.find((item) => item.nodeId === nodeId)).filter((item): item is CanvasVideoResourceOption => Boolean(item));
    const toggle = (nodeId: string) => { if (values.includes(nodeId)) onChange(values.filter((item) => item !== nodeId)); else if (values.length < 4) onChange([...values, nodeId]); };
    return <div className="relative"><button type="button" className="flex min-h-24 w-full min-w-0 items-center justify-center overflow-hidden rounded-xl border border-dashed p-2 text-center text-sm transition hover:opacity-90" style={{ background: theme.node.fill, borderColor: open ? theme.toolbar.activeText : theme.node.stroke, color: theme.node.text }} onClick={() => setOpen((current) => !current)}>{selected.length ? <span className="grid w-full min-w-0 gap-1.5 text-left">{selected.map((item) => <span key={item.nodeId} className="flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-lg border px-2 py-1 text-xs" style={{ borderColor: theme.node.stroke }}><ResourcePreview option={item} theme={theme} small /><span className="block min-w-0 flex-1 truncate">{optionTitle(item)}</span></span>)}</span> : <span className="opacity-55">请连接画布节点后选择素材</span>}</button>{open ? <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[1300] max-h-64 overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>{options.length ? options.map((item) => { const active = values.includes(item.nodeId); const disabled = !active && values.length >= 4; return <button key={item.nodeId} type="button" disabled={disabled} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition disabled:opacity-35" style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.text }} onClick={() => toggle(item.nodeId)}><ResourcePreview option={item} theme={theme} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{optionTitle(item)}</span><span className="block truncate opacity-65">{optionSubtitle(item)}</span></span><span className="text-xs opacity-60">{active ? "已选" : "选择"}</span></button>; }) : <div className="px-2 py-3 text-center text-xs opacity-55">暂无已连接素材</div>}</div> : null}</div>;
}

function PickerMenu<T extends { nodeId: string }>({ items, value, theme, renderPreview, renderTitle, renderSubtitle, onSelect }: { items: T[]; value: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; renderPreview: (item: T) => ReactNode; renderTitle: (item: T) => ReactNode; renderSubtitle: (item: T) => ReactNode; onSelect: (nodeId: string) => void }) {
    return <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[1300] max-h-56 overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>{items.map((item) => { const active = item.nodeId === value; return <button key={item.nodeId || "empty"} type="button" className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition" style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.text }} onClick={() => onSelect(item.nodeId)}>{renderPreview(item)}<span className="min-w-0 flex-1"><span className="block truncate font-medium">{renderTitle(item)}</span><span className="block truncate opacity-65">{renderSubtitle(item)}</span></span></button>; })}</div>;
}

function FramePreview({ option }: { option?: CanvasVideoFrameOption }) {
    if (option?.previewUrl) return <img src={option.previewUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
    return <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white/10"><ImageIcon className="size-4 opacity-55" /></span>;
}

function ResourcePreview({ option, theme, small = false }: { option?: CanvasVideoResourceOption; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; small?: boolean }) {
    const size = small ? "size-5" : "size-9";
    if (option?.kind === "image" && option.previewUrl) return <img src={option.previewUrl} alt="" className={[size, "shrink-0 rounded-md object-cover"].join(" ")} />;
    if (option?.kind === "video" && option.previewUrl) return <video src={option.previewUrl} className={[size, "shrink-0 rounded-md bg-black object-cover"].join(" ")} muted preload="metadata" />;
    const Icon = option?.kind === "audio" ? Music2 : option?.kind === "video" ? VideoIcon : option?.kind === "text" ? FileText : ImageIcon;
    return <span className={["flex shrink-0 items-center justify-center rounded-md", size].join(" ")} style={{ background: theme.node.fill }}><Icon className="size-4 opacity-55" /></span>;
}

function ClearButton({ onClick }: { onClick: () => void }) {
    return <span role="button" tabIndex={0} className="rounded-full p-1 opacity-55 transition hover:opacity-100" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClick(); }}><X className="size-3.5" /></span>;
}

function IconButton({ title, disabled = false, danger = false, theme, onClick, children }: { title: string; disabled?: boolean; danger?: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void; children: ReactNode }) {
    return <button type="button" title={title} disabled={disabled} className="grid size-8 place-items-center rounded-lg border text-xs transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: danger ? "#ef4444" : theme.node.text }} onClick={onClick}>{children}</button>;
}

function NumberField({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-8 w-16 rounded-full border bg-transparent px-2 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void; children: ReactNode }) {
    return <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>{children}</button>;
}

function CanvasSettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return <div className="space-y-2.5"><div className="text-xs font-medium" style={{ color }}>{title}</div>{children}</div>;
}

function SwitchRow({ label, hint, checked, theme, onChange }: { label: string; hint?: string; checked: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (checked: boolean) => void }) {
    return <div className="flex min-h-9 items-center justify-between gap-3"><span className="min-w-0"><span className="block text-sm" style={{ color: theme.node.text }}>{label}</span>{hint ? <span className="block text-[11px] leading-4 opacity-55">{hint}</span> : null}</span><span onMouseDown={(event) => event.stopPropagation()}><Switch size="small" checked={checked} onChange={onChange} /></span></div>;
}

function normalizeKlingMultiPrompt(value: CanvasNodeMetadata["klingMultiPrompt"] | undefined) {
    return Array.isArray(value) && value.length ? value.map((item) => ({ textNodeId: item.textNodeId || "", duration: item.duration || "1" })) : [{ textNodeId: "", duration: "1" }];
}

function normalizeKlingElementList(value: CanvasNodeMetadata["klingElementList"] | undefined) {
    return Array.isArray(value) && value.length ? value.slice(0, 3).map((item) => ({ name: item.name || "", description: item.description || "", nodeIds: normalizeNodeIds(item.nodeIds, 4) })) : [{ name: "", description: "", nodeIds: [] }];
}

function normalizeNodeIds(value: string[] | undefined, max: number) {
    return Array.from(new Set(Array.isArray(value) ? value.filter(Boolean) : [])).slice(0, max);
}

function boolValue(value: string | undefined) {
    return String(value || "").toLowerCase() === "true";
}

function optionTitle(item: CanvasVideoResourceOption) {
    if (item.kind === "text") return shortText(item.text || item.label, 10);
    return item.label;
}

function optionSubtitle(item: CanvasVideoResourceOption) {
    if (item.kind === "text") return item.text ? shortText(item.text, 24) : "文字节点";
    if (item.kind === "image") return "图片节点";
    if (item.kind === "video") return "视频节点";
    return "音频节点";
}

function shortText(value: string, max: number) {
    const text = String(value || "").trim();
    return text.length > max ? text.slice(0, max) + "..." : text;
}
