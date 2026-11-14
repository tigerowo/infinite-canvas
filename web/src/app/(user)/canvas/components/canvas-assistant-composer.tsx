"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowUp, Brain, FolderOpen, ImageIcon, Menu, Square, Upload, Video } from "lucide-react";
import { Button, Dropdown, Popover, Progress, Tooltip } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasAgentConfig, type CanvasAgentContextUsage, type CanvasAgentSkillSelection, type CanvasAssistantReference } from "../types";
import { canvasAgentInputBudget } from "../agent/canvas-agent-memory";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { CanvasAgentSkillPopover } from "./canvas-agent-skill-popover";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";

export type CanvasAssistantComposerProps = {
    prompt: string;
    isRunning: boolean;
    codexControls?: ReactNode;
    contextUsage?: CanvasAgentContextUsage;
    references: CanvasAssistantReference[];
    availableReferences?: CanvasResourceReference[];
    pendingReferences?: CanvasResourceReference[];
    selectedSkills?: CanvasAgentSkillSelection[];
    agentConfig: CanvasAgentConfig;
    onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
    onPromptChange: (prompt: string) => void;
    onReferenceIdsChange: (ids: string[]) => void;
    onSkillSelect?: (skill: CanvasAgentSkillSelection) => void;
    onSkillRemove?: (id: string, source: CanvasAgentSkillSelection["source"]) => void;
    onSubmit: (prompt?: string, referenceIds?: string[]) => void | Promise<void>;
    onStop?: () => void;
    onOpenUpload: () => void;
    onOpenAssets: () => void;
    onPasteImage: (file: File) => void;
};

export function CanvasAssistantComposer({
    prompt,
    isRunning,
    codexControls,
    contextUsage,
    references,
    availableReferences,
    pendingReferences,
    selectedSkills,
    agentConfig,
    onAgentConfigChange,
    onPromptChange,
    onReferenceIdsChange,
    onSkillSelect,
    onSkillRemove,
    onSubmit,
    onStop,
    onOpenUpload,
    onOpenAssets,
    onPasteImage,
}: CanvasAssistantComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const reasoningEnabled = agentConfig.textReasoningEnabled === true;
    const [contextOpen, setContextOpen] = useState(false);
    const codexMode = agentConfig.mode === "codex";
    const contextWindow = codexMode ? contextUsage?.contextWindow : canvasAgentInputBudget(effectiveConfig.textModel || effectiveConfig.model);
    const contextLimit = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
    const contextPercent = contextUsage && contextLimit ? Math.round(contextUsage.tokens / contextLimit * 100) : undefined;
    const contextLabel = contextPercent === undefined ? "—" : contextPercent + "%";
    const [usedTokens, totalTokens, remainingTokens] = [
        contextUsage?.tokens, contextLimit,
        contextUsage && contextLimit ? Math.max(0, contextLimit - contextUsage.tokens) : undefined,
    ].map((value) => value == null ? "—" : value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 }));
    const imageConfig = useMemo(() => ({ ...effectiveConfig, quality: agentConfig.imageQuality, size: agentConfig.imageSize }), [agentConfig.imageQuality, agentConfig.imageSize, effectiveConfig]);
    const videoConfig = useMemo(() => ({ ...effectiveConfig, activeChannelId: effectiveConfig.videoChannelId || effectiveConfig.activeChannelId, vquality: agentConfig.videoQuality, size: agentConfig.videoSize }), [agentConfig.videoQuality, agentConfig.videoSize, effectiveConfig]);
    const promptReferences = useMemo(() => {
        const seen = new Set<string>();
        return [...(availableReferences || []), ...references.map(assistantToPromptReference)].filter((reference) => {
            if (seen.has(reference.nodeId)) return false;
            seen.add(reference.nodeId);
            return true;
        });
    }, [availableReferences, references]);
    const submit = (nextPrompt = prompt, referenceIds = references.map((reference) => reference.id)) => onSubmit(nextPrompt, referenceIds);

    return (
        <div className="px-2 pb-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="rounded-2xl border px-3 pb-3 pt-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                <CanvasPromptChipInput
                    value={prompt}
                    references={promptReferences}
                    pendingReferences={pendingReferences}
                    skills={selectedSkills}
                    onSkillRemove={onSkillRemove}
                    onChange={onPromptChange}
                    onReferenceIdsChange={onReferenceIdsChange}
                    onPasteImage={onPasteImage}
                    onSubmit={submit}
                    className="thin-scrollbar min-h-20 max-h-[220px] w-full px-1 py-0 text-sm leading-5"
                    style={{ color: theme.node.text }}
                    placeholder="描述创作目标，或让我继续操作画布"
                    placeholderClassName="!left-1 !top-0"
                />
                <div className="@container mt-2 flex items-center justify-between gap-2">
                    <div className={`flex min-w-0 flex-1 items-center gap-1${codexMode ? " @max-[340px]:gap-px @max-[340px]:[&_.ant-btn]:!size-[30px] @max-[340px]:[&_.ant-btn]:!min-w-[30px] @max-[340px]:[&_.ant-btn]:!px-0 @max-[340px]:[&_.ant-btn]:!justify-center" : ""}`}>
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "upload", icon: <Upload className="size-4" />, label: "上传文件" },
                                    { key: "assets", icon: <FolderOpen className="size-4" />, label: "我的素材" },
                                ],
                                onClick: ({ key }) => (key === "upload" ? onOpenUpload() : onOpenAssets()),
                            }}
                        >
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.text }} icon={<Menu className="size-4" />} aria-label="添加素材" />
                        </Dropdown>
                        {onSkillSelect && onSkillRemove ? <CanvasAgentSkillPopover selectedSkills={selectedSkills} onSelect={onSkillSelect} onDeleteSelected={onSkillRemove} /> : null}
                        {codexControls}
                        <CanvasImageSettingsPopover
                            config={imageConfig}
                            placement="topLeft"
                            showCount={false}
                            buttonIcon={<ImageIcon className="size-3.5" />}
                            buttonClassName={`!h-8 !min-w-0 !max-w-[116px] !justify-start !rounded-full !px-2.5 ${codexMode ? "@max-[440px]:[&>.truncate]:sr-only" : "@max-[440px]:[&>.truncate]:sr-only"}`}
                            onConfigChange={(key, value) => {
                                if (key === "quality") onAgentConfigChange({ imageQuality: value });
                                else if (key === "size") onAgentConfigChange({ imageSize: value });
                            }}
                        />
                        <CanvasVideoSettingsPopover
                            config={videoConfig}
                            placement="topLeft"
                            visualOnly
                            buttonIcon={<Video className="size-3.5" />}
                            buttonClassName={`!h-8 !min-w-0 !max-w-[124px] !justify-start !rounded-full !px-2.5 ${codexMode ? "@max-[440px]:[&>.truncate]:sr-only" : "@max-[440px]:[&>.truncate]:sr-only"}`}
                            onConfigChange={(key, value) => {
                                if (key === "vquality") onAgentConfigChange({ videoQuality: value });
                                else if (key === "size") onAgentConfigChange({ videoSize: value });
                            }}
                        />
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {!codexControls ? (
                        <Button
                            type="text"
                            shape="circle"
                            className="!h-8 !w-8 !min-w-8"
                            style={{ color: theme.node.text, background: reasoningEnabled ? theme.toolbar.activeBg : undefined }}
                            icon={<Brain className="size-4" />}
                            title={reasoningEnabled ? "推理已开启" : "推理已关闭"}
                            aria-label={reasoningEnabled ? "关闭推理" : "开启推理"}
                            aria-pressed={reasoningEnabled}
                            onClick={() => onAgentConfigChange({ textReasoningEnabled: !reasoningEnabled })}
                        />
                        ) : null}
                        <Popover
                            trigger="click"
                            placement="topRight"
                            arrow={false}
                            open={contextOpen}
                            onOpenChange={setContextOpen}
                            styles={{ container: { padding: 0, background: theme.toolbar.panel, border: "1px solid " + theme.node.stroke, borderRadius: 16 } }}
                            content={
                                <div data-canvas-no-zoom tabIndex={-1} className="w-[348px] p-4 text-xs leading-5 outline-none" style={{ color: theme.node.muted }}>
                                    <div className="opacity-65">当前会话 · 上下文{codexMode ? "窗口" : "预算"}占用</div>
                                    <div className="mt-0.5 text-sm font-semibold" style={{ color: theme.node.text }}>上下文已用 {contextLabel}</div>
                                    <div className="mb-3 mt-4 flex items-baseline justify-between">
                                        <span><strong className="text-2xl tracking-tight" style={{ color: theme.node.text }}>{usedTokens}</strong> / {totalTokens} Token</span>
                                        <span>剩余 {remainingTokens}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>上下文{codexMode ? "窗口" : "预算"}占用</span>
                                        <strong style={{ color: theme.node.text }}>{contextLabel}</strong>
                                    </div>
                                    <div className="relative my-1 h-3">
                                        <Progress className="!block !leading-none" percent={contextPercent ?? 0} showInfo={false} size={["100%", 12]} strokeColor={theme.node.text} railColor={theme.node.faint} />
                                    </div>
                                    <div className="mt-2 text-[11px] leading-4 opacity-65">当前 {usedTokens} / {totalTokens}（{codexMode ? "Codex 上报" : "会话估算"}）。</div>
                                    <div className="mt-3 flex items-center justify-between leading-4">
                                        <span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: theme.node.faint }} />未使用</span>
                                        <span>{remainingTokens}</span>
                                    </div>
                                    <div className="mt-3 flex justify-between border-t pt-2 text-[11px] leading-4 opacity-65" style={{ borderColor: theme.node.stroke }}>
                                        <span>{codexMode ? "Codex 上报" : "Agent 会话估算"} · 不是计费 Token</span>
                                    </div>
                                </div>
                            }
                        >
                            <Tooltip
                                placement="top"
                                open={contextOpen ? false : undefined}
                                title={contextPercent === undefined ? "上下文尚未计算" : "上下文剩余 " + Math.max(0, 100 - contextPercent) + "%"}
                                color={theme.canvas.background}
                                styles={{ container: { color: theme.node.text, border: "1px solid " + theme.node.stroke, borderRadius: 6, fontSize: 12, padding: "4px 8px" } }}
                            >
                                <Button data-canvas-no-zoom type="text" className="!h-8 !gap-1.5 !rounded-full !px-2 !text-xs" style={{ color: theme.node.muted, background: theme.toolbar.itemHover }} aria-label="上下文用量" aria-expanded={contextOpen}>
                                    <Progress type="circle" percent={contextPercent ?? 0} size={18} strokeWidth={14} showInfo={false} strokeColor={theme.node.text} railColor={theme.node.stroke} />
                                    <span className={codexMode ? "@max-[340px]:sr-only" : "@max-[294px]:sr-only"}>{contextLabel}</span>
                                </Button>
                            </Tooltip>
                        </Popover>
                        <Button
                            type="primary"
                            shape="circle"
                            className="!size-10 !min-w-10"
                            disabled={!isRunning && !prompt.trim() && !selectedSkills?.length}
                            onClick={() => (isRunning ? onStop?.() : void submit())}
                            aria-label={isRunning ? "停止" : "发送"}
                            icon={isRunning ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-4" />}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
    const kind = reference.type === CanvasNodeType.Video ? "video" : reference.type === CanvasNodeType.Audio ? "audio" : reference.type === CanvasNodeType.Text ? "text" : "image";
    return { id: reference.id, nodeId: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewUrl: reference.dataUrl || reference.url, text: reference.text, active: true };
}
