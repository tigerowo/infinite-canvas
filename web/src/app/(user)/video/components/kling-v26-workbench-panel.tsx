import { ArrowLeft, ArrowRight, Plus, BookOpen, ClipboardPaste, FolderPlus, Music2, PanelBottom, PanelLeft, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { App, Button, Input, Switch, Tag } from "antd";
import { useEffect, useRef, type ReactNode } from "react";

import { ModelPicker } from "@/components/model-picker";
import { boolConfig } from "@/lib/seedance-video";
import type { AiConfig, VideoElementItem, VideoElementReference, VideoMultiPromptItem } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type WorkbenchLayout = "side" | "bottom";
type AssetPickerTarget = "general" | "image" | "video" | "audio" | "firstFrame" | "lastFrame";

const TEXT = {
    prompt: "提示词",
    pastePrompt: "读取剪贴板",
    clear: "清空",
    promptLibrary: "提示词库",
    assets: "我的素材",
    promptPlaceholder: "描述镜头运动、主体动作、场景氛围和画面风格",
    negativePrompt: "负面提示词",
    negativePlaceholder: "描述不希望出现在视频中的内容",
    referenceImage: "首尾帧",
    clipboard: "剪贴板",
    upload: "上传",
    chooseAsset: "从素材库选择",
    model: "模型",
    mode: "模式选择",
    std: "标准模式(720P 无声)",
    pro: "专业模式(1080P 音频)",
    k4: "4K模式",
    size: "尺寸",
    seconds: "秒数",
    audioTitle: "音频生成",
    generateAudio: "生成音频",
    audioSwitchLabel: "是否生成与视频同步的AI音频",
    audioHint: "仅专业模式，仅一张参考图可用",
    multiShotTitle: "多镜头分镜",
    multiShotHint: "是否启用多镜头分镜模式",
    shotType: "分镜模式",
    shotCustom: "自定义",
    shotSmart: "智能分镜",
    shotPrompt: "分镜提示词",
    shotPlaceholder: "描述当前分镜的镜头内容",
    addShot: "新增分镜提示词",
    deleteShot: "删除",
    taskCount: "任务数量",
    task: "任务",
    start: "开始生成",
    runningPrefix: "生成中（",
    runningSuffix: "）",
    title: "视频创作台",
    side: "侧边",
    bottom: "底部",
    image: "图",
    removeImage: "移除参考图",
    emptyImages: "暂无首尾帧，支持单首帧",
    elementList: "元素列表",
    elementName: "元素名称，在提示词中使用@前缀引用",
    elementDescription: "元素描述",
    elementEmpty: "暂无参考图，最多 2-4 张\n暂无参考视频，有效长度需至少 3-8 秒\n暂无参考音频，音频时长必须为 5-30 秒",
    addElement: "新增元素",
    deleteElement: "删除元素",
};

export function KlingV26WorkbenchPanel({
    isKlingV3,
    klingProvider = "apimart",
    klingOmniVariant = "",
    referenceVideoCount = 0,
    referenceVideoSection,
    currentLayout,
    prompt,
    negativePrompt,
    references,
    config,
    model,
    canGenerate,
    running,
    pendingCount,
    taskCount,
    onTaskCountChange,
    updateConfig,
    openConfigDialog,
    onLayoutChange,
    onPromptChange,
    onNegativePromptChange,
    onOpenPromptLibrary,
    onOpenAssetPicker,
    onPastePrompt,
    onClearPrompt,
    onPasteReferences,
    onUploadReferences,
    onRemoveReference,
    onMoveReference,
    onPasteElementReferences,
    onUploadElementReferences,
    onOpenElementAssetPicker,
    onRemoveElementReference,
    onMoveElementReference,
    onGenerate,
}: {
    isKlingV3: boolean;
    klingProvider?: "apimart" | "kie";
    klingOmniVariant?: string;
    referenceVideoCount?: number;
    referenceVideoSection?: ReactNode;
    currentLayout: WorkbenchLayout;
    prompt: string;
    negativePrompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    canGenerate: boolean;
    running: boolean;
    pendingCount: number;
    taskCount: number;
    onTaskCountChange: (value: number) => void;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onPromptChange: (value: string) => void;
    onNegativePromptChange: (value: string) => void;
    onOpenPromptLibrary: () => void;
    onOpenAssetPicker: (target?: AssetPickerTarget) => void;
    onPastePrompt: () => void;
    onClearPrompt: () => void;
    onPasteReferences: () => void;
    onUploadReferences: () => void;
    onRemoveReference: (id: string) => void;
    onMoveReference: (index: number, offset: number) => void;
    onPasteElementReferences: (elementIndex: number) => void;
    onUploadElementReferences: (elementIndex: number) => void;
    onOpenElementAssetPicker: (elementIndex: number) => void;
    onRemoveElementReference: (elementIndex: number, id: string) => void;
    onMoveElementReference: (elementIndex: number, index: number, offset: number) => void;
    onGenerate: () => void;
}) {
    const { message } = App.useApp();
    const mode = isKlingV3 && config.videoMode === "4k" ? "4k" : config.videoMode === "pro" ? "pro" : "std";
    const seconds = isKlingV3 ? String(config.videoSeconds ?? "") : config.videoSeconds === "10" ? "10" : "5";
    const ratio = klingRatioValue(config.size);
    const generateAudio = boolConfig(config.videoGenerateAudio, false);
    const isKIEKlingV3 = isKlingV3 && klingProvider === "kie";
    const supportsMultiShot = klingOmniVariant !== "transformation";
    const supportsSmartShots = !isKIEKlingV3 || klingOmniVariant === "text-to-video" || klingOmniVariant === "image-to-video";
    const showsReferenceImages = klingOmniVariant !== "text-to-video";
    const showsElements = klingOmniVariant !== "transformation";
    const usesFrameImages = !klingOmniVariant || klingOmniVariant === "image-to-video";
    const audioDisabled = (!isKlingV3 && (mode !== "pro" || references.length > 1)) || (klingOmniVariant === "reference-to-video" && referenceVideoCount > 0);
    const multiShot = isKlingV3 && supportsMultiShot && boolConfig(config.videoMultiShot, false);
    const shotType = config.videoShotType === "customize" ? "customize" : "intelligence";
    const multiPrompts = normalizeMultiPrompts(config.videoMultiPrompt);
    const elementList = normalizeElementList(config.videoElementList);
    const initializedV3SecondsRef = useRef(false);

    useEffect(() => {
        if (!isKlingV3 || initializedV3SecondsRef.current) return;
        initializedV3SecondsRef.current = true;
        if (String(config.videoSeconds || "").trim() === "6") updateConfig("videoSeconds", "3");
    }, [config.videoSeconds, isKlingV3, updateConfig]);

    const setMode = (value: string) => {
        updateConfig("videoMode", value);
        if (!isKlingV3 && value !== "pro") updateConfig("videoGenerateAudio", "false");
    };

    const setAudio = (checked: boolean) => {
        if (checked && audioDisabled) return;
        updateConfig("videoGenerateAudio", String(checked));
    };

    const setMultiShot = (checked: boolean) => {
        updateConfig("videoMultiShot", String(checked));
        if (checked && supportsSmartShots && !config.videoShotType) updateConfig("videoShotType", "intelligence");
        if (checked && !config.videoMultiPrompt?.length) updateConfig("videoMultiPrompt", defaultMultiPrompts());
    };

    const updateMultiPrompt = (index: number, patch: Partial<VideoMultiPromptItem>) => {
        updateConfig("videoMultiPrompt", multiPrompts.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
    };

    const addMultiPrompt = () => {
        updateConfig("videoMultiPrompt", [...multiPrompts, { prompt: "", duration: "1" }]);
    };

    const removeMultiPrompt = (index: number) => {
        if (multiPrompts.length <= 1) return;
        updateConfig("videoMultiPrompt", multiPrompts.filter((_, itemIndex) => itemIndex !== index));
    };

    const updateElementList = (items: VideoElementItem[]) => {
        updateConfig("videoElementList", normalizeElementList(items));
    };

    const updateElement = (index: number, patch: Partial<VideoElementItem>) => {
        updateElementList(elementList.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
    };

    const addElement = () => {
        if (elementList.length >= 3) return;
        updateElementList([...elementList, defaultElementItem()]);
    };

    const removeElement = (index: number) => {
        if (elementList.length <= 1) return;
        updateElementList(elementList.filter((_, itemIndex) => itemIndex !== index));
    };

    const pasteMultiPrompt = async (index: number) => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            updateMultiPrompt(index, { prompt: text });
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    const pasteNegativePrompt = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            onNegativePromptChange(text);
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 p-4 pb-3">
                <KlingHeader currentLayout={currentLayout} onLayoutChange={onLayoutChange} />
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
                {isKlingV3 && supportsMultiShot ? (
                    <KlingSection title={TEXT.multiShotTitle}>
                        <div className="grid gap-2 rounded-xl border border-stone-200 p-2.5 dark:border-stone-800">
                            <div className="flex h-8 items-center justify-between gap-3">
                                <span className="text-sm">{TEXT.multiShotHint}</span>
                                <Switch size="small" checked={multiShot} onChange={setMultiShot} />
                            </div>
                        </div>
                    </KlingSection>
                ) : null}
                <KlingSection title={TEXT.prompt}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPastePrompt}>{TEXT.pastePrompt}</Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={onClearPrompt}>{TEXT.clear}</Button>
                            <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={onOpenPromptLibrary}>{TEXT.promptLibrary}</Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onOpenAssetPicker()}>{TEXT.assets}</Button>
                        </div>
                        <Input.TextArea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={6} placeholder={TEXT.promptPlaceholder} />
                    </div>
                </KlingSection>
                {!isKIEKlingV3 ? <KlingSection title={TEXT.negativePrompt}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void pasteNegativePrompt()}>{TEXT.pastePrompt}</Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => onNegativePromptChange("")}>{TEXT.clear}</Button>
                        </div>
                        <Input.TextArea value={negativePrompt} onChange={(event) => onNegativePromptChange(event.target.value)} rows={4} placeholder={TEXT.negativePlaceholder} />
                    </div>
                </KlingSection> : null}
                {showsReferenceImages ? <KlingSection title={usesFrameImages ? TEXT.referenceImage : "参考图"} count={references.length}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences}>{TEXT.clipboard}</Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={onUploadReferences}>{TEXT.upload}</Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onOpenAssetPicker("image")}>{TEXT.chooseAsset}</Button>
                        </div>
                        <KlingReferenceImageStrip references={references} emptyText={usesFrameImages ? TEXT.emptyImages : "暂无参考图"} onRemoveReference={onRemoveReference} onMoveReference={onMoveReference} />
                    </div>
                </KlingSection> : null}
                {referenceVideoSection ? <KlingSection title="参考视频" count={referenceVideoCount}>{referenceVideoSection}</KlingSection> : null}
                {isKlingV3 && showsElements ? (
                    <KlingElementListSection
                        items={elementList}
                        onAddElement={addElement}
                        onRemoveElement={removeElement}
                        onUpdateElement={updateElement}
                        onPasteElementReferences={onPasteElementReferences}
                        onUploadElementReferences={onUploadElementReferences}
                        onOpenElementAssetPicker={onOpenElementAssetPicker}
                        onRemoveElementReference={onRemoveElementReference}
                        onMoveElementReference={onMoveElementReference}
                    />
                ) : null}
                {multiShot && supportsSmartShots ? (
                    <KlingSection title={TEXT.shotType}>
                        <OptionGrid columns={2} options={[{ value: "customize", label: TEXT.shotCustom }, { value: "intelligence", label: TEXT.shotSmart }]} value={shotType} onChange={(value) => updateConfig("videoShotType", value)} />
                    </KlingSection>
                ) : null}
                {multiShot && (!supportsSmartShots || shotType === "customize") ? multiPrompts.map((item, index) => (
                    <KlingSection key={index} title={TEXT.shotPrompt + (index + 1)} extra={
                        <div className="flex items-center gap-1">
                            <Button size="small" type="text" title={TEXT.addShot} className="!h-6 !w-6 !p-0" icon={<Plus className="size-3.5" />} onClick={addMultiPrompt} />
                            <Button size="small" type="text" danger title={TEXT.deleteShot} className="!h-6 !w-6 !p-0" icon={<Trash2 className="size-3.5" />} disabled={multiPrompts.length <= 1} onClick={() => removeMultiPrompt(index)} />
                        </div>
                    }>
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap gap-1">
                                    <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void pasteMultiPrompt(index)}>{TEXT.pastePrompt}</Button>
                                    <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => updateMultiPrompt(index, { prompt: "" })}>{TEXT.clear}</Button>
                                </div>
                                <KlingNumberInput value={item.duration || "1"} min={1} max={15} onChange={(value) => updateMultiPrompt(index, { duration: value })} />
                            </div>
                            <Input.TextArea value={item.prompt} onChange={(event) => updateMultiPrompt(index, { prompt: event.target.value })} rows={4} placeholder={TEXT.shotPlaceholder} />
                        </div>
                    </KlingSection>
                )) : null}
                <KlingSection title={TEXT.model}>
                    <ModelPicker config={config} value={model} channelId={config.videoChannelId} onChange={(value, channelId) => { updateConfig("videoModel", value); if (channelId) updateConfig("videoChannelId", channelId); }} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
                </KlingSection>
                <KlingSection title={TEXT.mode}>
                    <OptionGrid columns={isKlingV3 ? 3 : 2} options={isKlingV3 ? [{ value: "std", label: "720P" }, { value: "pro", label: "1080P" }, { value: "4k", label: "4K" }] : [{ value: "std", label: TEXT.std }, { value: "pro", label: TEXT.pro }]} value={mode} onChange={setMode} />
                </KlingSection>
                <KlingSection title={TEXT.size}>
                    <OptionGrid columns={3} options={[{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }, { value: "1:1", label: "1:1" }]} value={ratio} onChange={(value) => updateConfig("size", value === "1:1" ? "1024x1024" : value)} />
                </KlingSection>
                <KlingSection title={TEXT.seconds}>
                    {isKlingV3 ? (
                        <div className="grid grid-cols-3 gap-2.5">
                            {[{ value: "3", label: "3s" }, { value: "15", label: "15s" }].map((item) => (
                                <button key={item.value} type="button" className={optionClass(seconds === item.value)} onClick={() => updateConfig("videoSeconds", item.value)}>
                                    {item.label}
                                </button>
                            ))}
                            <KlingNumberInput value={seconds} min={3} max={15} onChange={(value) => updateConfig("videoSeconds", value)} />
                        </div>
                    ) : (
                        <OptionGrid options={[{ value: "5", label: "5s" }, { value: "10", label: "10s" }]} value={seconds} onChange={(value) => updateConfig("videoSeconds", value)} />
                    )}
                </KlingSection>
                <KlingSection title={TEXT.audioTitle}>
                    <div className="grid gap-2 rounded-xl border border-stone-200 p-2.5 dark:border-stone-800">
                        <div className="flex h-8 items-center justify-between gap-3">
                            <span className="text-sm">{TEXT.audioSwitchLabel}</span>
                            <Switch size="small" checked={generateAudio && !audioDisabled} disabled={audioDisabled} onChange={setAudio} />
                        </div>
                        {!isKlingV3 ? <p className="text-xs text-stone-500 dark:text-stone-400">{TEXT.audioHint}</p> : null}
                    </div>
                </KlingSection>
                <KlingSection title={TEXT.taskCount}>
                    <KlingTaskCount value={taskCount} onChange={onTaskCountChange} />
                </KlingSection>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate} onClick={onGenerate}>
                    {pendingCount ? TEXT.runningPrefix + pendingCount + TEXT.runningSuffix : TEXT.start}
                </Button>
            </div>
        </div>
    );
}

function KlingHeader({ currentLayout, onLayoutChange }: { currentLayout: WorkbenchLayout; onLayoutChange: (layout: WorkbenchLayout) => void }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{TEXT.title}</h1>
            <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                <Button size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>{TEXT.side}</Button>
                <Button size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>{TEXT.bottom}</Button>
            </div>
        </div>
    );
}

function KlingSection({ title, count, extra, children }: { title: string; count?: number; extra?: ReactNode; children: ReactNode }) {
    return (
        <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{title}</span>
                    {typeof count === "number" ? <Tag className="m-0 text-xs">{count}</Tag> : null}
                </div>
                {extra}
            </div>
            <div className="space-y-2 border-t border-stone-200 p-3 dark:border-stone-800">{children}</div>
        </section>
    );
}

function OptionGrid({ options, value, onChange, columns = 2 }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; columns?: 2 | 3 }) {
    return (
        <div className={columns === 3 ? "grid grid-cols-3 gap-2.5" : "grid grid-cols-2 gap-2.5"}>
            {options.map((item) => (
                <button key={item.value} type="button" className={optionClass(value === item.value)} onClick={() => onChange(item.value)}>
                    {item.label}
                </button>
            ))}
        </div>
    );
}

function optionClass(active: boolean) {
    return [
        "h-9 rounded-full border bg-transparent px-2 text-sm font-medium transition hover:opacity-80",
        active ? "border-stone-950 text-stone-950 dark:border-stone-100 dark:text-stone-100" : "border-stone-200 text-stone-700 dark:border-stone-800 dark:text-stone-200",
    ].join(" ");
}

function KlingElementListSection({ items, onAddElement, onRemoveElement, onUpdateElement, onPasteElementReferences, onUploadElementReferences, onOpenElementAssetPicker, onRemoveElementReference, onMoveElementReference }: { items: VideoElementItem[]; onAddElement: () => void; onRemoveElement: (index: number) => void; onUpdateElement: (index: number, patch: Partial<VideoElementItem>) => void; onPasteElementReferences: (elementIndex: number) => void; onUploadElementReferences: (elementIndex: number) => void; onOpenElementAssetPicker: (elementIndex: number) => void; onRemoveElementReference: (elementIndex: number, id: string) => void; onMoveElementReference: (elementIndex: number, index: number, offset: number) => void }) {
    return (
        <KlingSection title={TEXT.elementList}>
            <div className="space-y-3">
                {items.map((item, index) => (
                    <div key={index} className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                        <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{TEXT.elementList}{index + 1}</span>
                                <Tag className="m-0 text-xs">{item.references.length}</Tag>
                            </div>
                            <div className="flex items-center gap-1">
                                <Button size="small" type="text" title={TEXT.addElement} className="!h-6 !w-6 !p-0" icon={<Plus className="size-3.5" />} disabled={items.length >= 3} onClick={onAddElement} />
                                <Button size="small" type="text" danger title={TEXT.deleteElement} className="!h-6 !w-6 !p-0" icon={<Trash2 className="size-3.5" />} disabled={items.length <= 1} onClick={() => onRemoveElement(index)} />
                            </div>
                        </div>
                        <div className="space-y-2 p-3">
                            <div className="flex flex-wrap gap-1">
                                <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => onPasteElementReferences(index)}>{TEXT.clipboard}</Button>
                                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => onUploadElementReferences(index)}>{TEXT.upload}</Button>
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onOpenElementAssetPicker(index)}>{TEXT.chooseAsset}</Button>
                            </div>
                            <div style={{ display: "grid", gap: 8 }}>
                                <Input value={item.name} onChange={(event) => onUpdateElement(index, { name: event.target.value })} placeholder={TEXT.elementName} />
                                <Input value={item.description} onChange={(event) => onUpdateElement(index, { description: event.target.value })} placeholder={TEXT.elementDescription} />
                            </div>
                            <div className="pt-2">
                                <KlingElementReferenceStrip references={item.references} onRemoveReference={(id) => onRemoveElementReference(index, id)} onMoveReference={(itemIndex, offset) => onMoveElementReference(index, itemIndex, offset)} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </KlingSection>
    );
}

function KlingElementReferenceStrip({ references, onRemoveReference, onMoveReference }: { references: VideoElementReference[]; onRemoveReference: (id: string) => void; onMoveReference: (index: number, offset: number) => void }) {
    return (
        <div className="hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden min-h-24 rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
            {references.map((item, index) => (
                <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
                    {item.kind === "image" ? <img src={item.dataUrl || item.url} alt={item.name} className="size-full object-cover" /> : item.kind === "video" ? <video src={item.url} className="size-full object-cover" muted preload="metadata" /> : <div className="flex size-full flex-col items-center justify-center gap-1 px-1 text-center text-xs text-stone-500"><Music2 className="size-5" /><span className="line-clamp-2">{item.name}</span></div>}
                    {item.kind === "video" ? <VideoIcon className="absolute bottom-1 left-1 size-3.5 text-white drop-shadow" /> : null}
                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                    <KlingReferenceOrderButtons index={index} total={references.length} onMove={(offset) => onMoveReference(index, offset)} />
                    <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label={TEXT.removeImage}>
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ))}
            {!references.length ? <div className="flex min-w-full items-center justify-center whitespace-pre-line text-center text-sm text-stone-500">{TEXT.elementEmpty}</div> : null}
        </div>
    );
}

function KlingReferenceImageStrip({ references, emptyText = TEXT.emptyImages, onRemoveReference, onMoveReference }: { references: ReferenceImage[]; emptyText?: string; onRemoveReference: (id: string) => void; onMoveReference: (index: number, offset: number) => void }) {
    return (
        <div className="hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden min-h-24 rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
            {references.map((item, index) => (
                <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                    <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{TEXT.image}{index + 1}</span>
                    <KlingReferenceOrderButtons index={index} total={references.length} onMove={(offset) => onMoveReference(index, offset)} />
                    <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label={TEXT.removeImage}>
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ))}
            {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{emptyText}</div> : null}
        </div>
    );
}

function KlingReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function KlingNumberInput({ value, min, max, onChange }: { value: string; min: number; max: number; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 rounded-full border border-stone-200 bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] dark:border-stone-800 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => onChange(clampNumberInputValue(event.target.value, min, max))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function clampNumberInputValue(value: string, min: number, max: number) {
    const number = Math.floor(Number(value) || min);
    return String(Math.max(min, Math.min(max, number)));
}


function KlingTaskCount({ value, onChange }: { value: number; onChange: (value: number) => void }) {
    return (
        <label className="flex h-11 items-center gap-2 rounded-xl border border-stone-200 bg-background px-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <span className="shrink-0">{TEXT.task}</span>
            <input className="h-7 w-16 rounded-lg border border-stone-200 bg-background px-2 text-sm text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" type="number" min={1} max={6} value={value} onChange={(event) => onChange(normalizeVideoCount(event.target.value))} />
        </label>
    );
}

function normalizeKlingV3Seconds(value: string) {
    const seconds = Math.floor(Number(value) || 3);
    return String(Math.max(3, Math.min(15, seconds)));
}


function defaultMultiPrompts(): VideoMultiPromptItem[] {
    return [{ prompt: "", duration: "1" }];
}

function defaultElementItem(): VideoElementItem {
    return { name: "", description: "", references: [] };
}

function normalizeElementList(value: VideoElementItem[] | undefined): VideoElementItem[] {
    if (!Array.isArray(value) || !value.length) return [defaultElementItem()];
    return value.slice(0, 3).map((item) => ({ name: item?.name || "", description: item?.description || "", references: Array.isArray(item?.references) ? item.references.slice(0, 4) : [] }));
}

function normalizeMultiPrompts(value: VideoMultiPromptItem[] | undefined): VideoMultiPromptItem[] {
    if (!Array.isArray(value) || !value.length) return defaultMultiPrompts();
    return value.map((item) => ({ prompt: item?.prompt || "", duration: item?.duration || "1" }));
}

function normalizeVideoCount(value: string | number) {
    const count = Math.floor(Number(value) || 1);
    return Math.max(1, Math.min(6, count));
}

function klingRatioValue(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["9:16", "720x1280", "1080x1920"].includes(normalized)) return "9:16";
    if (["1024x1024", "1080x1080"].includes(normalized)) return "1:1";
    return "16:9";
}
