"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowUp, Brain, FolderOpen, ImageIcon, Menu, Settings2, Square, Upload, Video } from "lucide-react";
import { Button, Dropdown } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { channelProtocolForConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { reasoningLabels, reasoningOptions, resolveReasoning, type ReasoningEffort } from "@/extensions/model-capabilities/reasoning";
import { SettingsPopover } from "@/extensions/glass-ui/settings-popover";
import { ModelPicker } from "@/components/model-picker";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasAgentConfig, type CanvasAgentSkillSelection, type CanvasAssistantReference } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { CanvasAgentSkillPopover } from "./canvas-agent-skill-popover";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";

export type CanvasAssistantComposerProps = {
    prompt: string;
    isRunning: boolean;
    codexControls?: ReactNode;
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
    const canConfigure = useUserStore((state) => state.isReady && Boolean(state.token && state.user && state.user.role !== "guest"));
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const textConfig = { ...effectiveConfig, model: effectiveConfig.textModel, activeChannelId: effectiveConfig.textChannelId || effectiveConfig.activeChannelId };
    const textProtocol = channelProtocolForConfig(textConfig);
    const effort = resolveReasoning(textConfig.model, textProtocol, agentConfig.textReasoningEffort, agentConfig.textReasoningEnabled);
    const efforts = reasoningOptions(textConfig.model, textProtocol);
    const imageConfig = useMemo(() => ({ ...effectiveConfig, model: effectiveConfig.imageModel, activeChannelId: effectiveConfig.imageChannelId, quality: agentConfig.imageQuality, size: agentConfig.imageSize }), [agentConfig.imageQuality, agentConfig.imageSize, effectiveConfig]);
    const videoConfig = useMemo(() => ({ ...effectiveConfig, model: effectiveConfig.videoModel, activeChannelId: effectiveConfig.videoChannelId, vquality: agentConfig.videoQuality, size: agentConfig.videoSize }), [agentConfig.videoQuality, agentConfig.videoSize, effectiveConfig]);
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
        <div data-media-assistant-draft className="px-2 pb-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="glass-surface-strong rounded-2xl border px-3 pb-3 pt-3" style={{ color: theme.node.text }}>
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
                    placeholder="发送消息"
                    placeholderClassName="!left-1 !top-0"
                />
                <div className="@container mt-2 flex flex-wrap items-center gap-2">
                    <div className={`flex min-w-0 flex-1 items-center gap-1 ${codexControls ? "flex-wrap" : ""}`}>
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
                        {canConfigure ? <SettingsPopover title="工具设置" placement="topLeft" trigger={<Button type="text" shape="circle" className="!size-8 !min-w-8" icon={<Settings2 className="size-4" />} aria-label="工具设置" title="工具设置" />}>
                        <div className="flex flex-col gap-3">
                        <p className="text-xs leading-5 opacity-65">在对话中说明要生成图片还是视频，Agent 会调用下方对应模型。</p>
                        <div className="text-sm font-medium">图片生成</div>
                        <ModelPicker config={effectiveConfig} capability="image" value={effectiveConfig.imageModel} channelId={effectiveConfig.imageChannelId} fullWidth onChange={(model, channelId) => { updateConfig("imageModel", model); if (channelId) updateConfig("imageChannelId", channelId); }} />
                        <CanvasImageSettingsPopover
                            config={imageConfig}
                            placement="topLeft"
                            showCount={false}
                            buttonIcon={<ImageIcon className="size-3.5" />}
                            buttonClassName="!h-8 !max-w-[116px] !justify-start !rounded-full !px-2.5"
                            onConfigChange={(key, value) => {
                                if (key === "quality") onAgentConfigChange({ imageQuality: value });
                                else if (key === "size") onAgentConfigChange({ imageSize: value });
                            }}
                        />
                        <div className="text-sm font-medium">视频生成</div>
                        <ModelPicker config={effectiveConfig} capability="video" value={effectiveConfig.videoModel} channelId={effectiveConfig.videoChannelId} fullWidth onChange={(model, channelId) => { updateConfig("videoModel", model); if (channelId) updateConfig("videoChannelId", channelId); }} />
                        <CanvasVideoSettingsPopover
                            config={videoConfig}
                            placement="topLeft"
                            visualOnly
                            buttonIcon={<Video className="size-3.5" />}
                            buttonClassName="!h-8 !max-w-[124px] !justify-start !rounded-full !px-2.5"
                            onConfigChange={(key, value) => {
                                if (key === "vquality") onAgentConfigChange({ videoQuality: value });
                                else if (key === "size") onAgentConfigChange({ videoSize: value });
                            }}
                        />
                        </div>
                        </SettingsPopover> : null}
                        {canConfigure && onSkillSelect && onSkillRemove ? <CanvasAgentSkillPopover selectedSkills={selectedSkills} onSelect={onSkillSelect} onDeleteSelected={onSkillRemove} /> : null}
                        {canConfigure ? (!codexControls ? <ModelPicker
                            config={effectiveConfig}
                            value={effectiveConfig.textModel}
                            channelId={effectiveConfig.textChannelId}
                            capability="text"
                            className="!h-9 !w-[160px] !min-w-0 !max-w-full !shrink"
                            onChange={(model, channelId) => {
                                updateConfig("textModel", model);
                                if (channelId) updateConfig("textChannelId", channelId);
                            }}
                            onMissingConfig={() => openConfigDialog()}
                        /> : codexControls) : <span className="px-1 text-xs opacity-60">登录后选择模型并开始创作</span>}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                        {canConfigure && !codexControls ? (
                        <Dropdown trigger={["click"]} placement="topRight" autoAdjustOverflow menu={{
                            selectable: true,
                            selectedKeys: [effort],
                            items: efforts.map((key) => ({ key, label: reasoningLabels[key] })),
                            onClick: ({ key }) => onAgentConfigChange({ textReasoningEffort: key as ReasoningEffort, textReasoningEnabled: key !== "auto" && key !== "none" }),
                        }}>
                            <Button type="text" className="!h-9 !px-2" icon={<Brain className="size-4" />} aria-label={`思考强度：${reasoningLabels[effort]}`}>{reasoningLabels[effort]}</Button>
                        </Dropdown>
                        ) : null}
                        <Button
                            type="primary"
                            shape="circle"
                            className="!size-10 !min-w-10"
                            disabled={!isRunning && !prompt.trim()}
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
