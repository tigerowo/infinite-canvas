"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    History,
    Bot,
    Copy,
    PanelRightClose,
    Plus,
    RotateCcw,
    Settings2,
    Sparkles,
    Trash2,
    Video,
    X,
} from "lucide-react";
import { App, Button, Modal, Switch, Tooltip } from "antd";
import { motion } from "motion/react";
import { nanoid } from "nanoid";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ImageGenerationPending } from "@/components/image-generation-pending";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasThemes } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { fetchSystemAgentSkillFile } from "@/services/api/agent-skills";
import { imageToDataUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { createCanvasAgentState, runCanvasAgent } from "../agent/canvas-agent-runtime";
import type { CanvasAgentContext } from "../agent/canvas-agent-context";
import type { CanvasAgentAction, CanvasAgentToolResult } from "../agent/canvas-agent-tools";
import {
    MAX_CANVAS_AGENT_SKILLS,
    CanvasNodeType,
    type CanvasAgentConfig,
    type CanvasAgentSkillSelection,
    type CanvasAgentState,
    type CanvasAssistantMessage,
    type CanvasAssistantReference,
    type CanvasAssistantSession,
    type CanvasNodeData,
} from "../types";
import { assistantReferenceContentFromNode, buildAllCanvasResourceReferences, type CanvasResourceReference } from "../utils/canvas-resource-references";
import { assistantToPromptReference, CanvasAssistantComposer } from "./canvas-assistant-composer";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";

const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;

type CanvasAssistantPanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    referenceNodeClick: { nodeId: string | null; version: number };
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    agentConfig: CanvasAgentConfig;
    width: number;
    onWidthChange: (width: number) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
    onPasteImage: (file: File) => void;
    onOpenUpload: () => void;
    onOpenAssets: () => void;
    getAgentContext: (state: CanvasAgentState) => CanvasAgentContext;
    onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    onCollapseStart: () => void;
    onCollapse: () => void;
    initialRequest?: { prompt: string; references: CanvasAssistantReference[] } | null;
    onInitialRequestConsumed?: () => void;
};

type PendingDeleteConfirmation = {
    title: string;
    resolve: (confirmed: boolean) => void;
};

export function CanvasAssistantPanel({
    nodes,
    selectedNodeIds,
    referenceNodeClick,
    sessions,
    activeSessionId,
    agentConfig,
    width,
    onWidthChange,
    onSessionsChange,
    onAgentConfigChange,
    onPasteImage,
    onOpenUpload,
    onOpenAssets,
    getAgentContext,
    onExecuteAction,
    onCollapseStart,
    onCollapse,
    initialRequest,
    onInitialRequestConsumed,
}: CanvasAssistantPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const { message: appMessage } = App.useApp();
    const abortRef = useRef<AbortController | null>(null);
    const consumedInitialRequestRef = useRef<typeof initialRequest>(null);
    const pendingDeleteRef = useRef<PendingDeleteConfirmation | null>(null);
    const messageListRef = useRef<HTMLDivElement>(null);
    const consumedReferenceNodeClickVersionRef = useRef(0);
    const [view, setView] = useState<"chat" | "history">("chat");
    const [prompt, setPrompt] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [checkedChatIds, setCheckedChatIds] = useState<string[]>([]);
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [composerReferenceIds, setComposerReferenceIds] = useState<string[]>([]);
    const [selectedSkills, setSelectedSkills] = useState<CanvasAgentSkillSelection[]>([]);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
    const [initialSession] = useState(createSession);
    const safeSessions = sessions.length ? sessions : [initialSession];
    const resolvedActiveSessionId = activeSessionId && safeSessions.some((session) => session.id === activeSessionId) ? activeSessionId : safeSessions[0]?.id || null;
    const sessionsRef = useRef<CanvasAssistantSession[]>(safeSessions);
    const activeSessionIdRef = useRef<string | null>(resolvedActiveSessionId);

    useEffect(() => {
        sessionsRef.current = safeSessions;
        activeSessionIdRef.current = resolvedActiveSessionId;
    }, [resolvedActiveSessionId, sessions]);

    useEffect(() => () => {
        abortRef.current?.abort();
        pendingDeleteRef.current?.resolve(false);
        pendingDeleteRef.current = null;
    }, []);

    const activeSession = safeSessions.find((session) => session.id === resolvedActiveSessionId) || safeSessions[0] || null;
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const hasMessages = messages.length > 0;
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);

    useEffect(() => {
        if (view !== "chat") return;
        const frame = window.requestAnimationFrame(() => {
            const element = messageListRef.current;
            if (element) element.scrollTop = element.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [messages, view]);
    const resourceReferences = useMemo(() => buildAllCanvasResourceReferences(nodes), [nodes]);
    const resourceReferenceById = useMemo(() => new Map(resourceReferences.map((reference) => [reference.nodeId, reference])), [resourceReferences]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const resolveReferences = useCallback((ids: string[]) => ids.flatMap((id) => {
        const node = nodeById.get(id);
        const resource = resourceReferenceById.get(id);
        const reference = node && resource ? nodeToReference(node, resource) : null;
        return reference ? [reference] : [];
    }), [nodeById, resourceReferenceById]);
    const composerReferences = useMemo(() => resolveReferences(composerReferenceIds), [composerReferenceIds, resolveReferences]);
    const pendingReferences = useMemo(() => {
        const pendingClickNodeId = referenceNodeClick.version > consumedReferenceNodeClickVersionRef.current ? referenceNodeClick.nodeId : null;
        return resourceReferences.filter(
            (reference) => selectedNodeIds.has(reference.nodeId) && ((!composerReferenceIds.includes(reference.nodeId) && !removedReferenceIds.has(reference.nodeId)) || reference.nodeId === pendingClickNodeId),
        );
    }, [composerReferenceIds, referenceNodeClick, removedReferenceIds, resourceReferences, selectedNodeIds]);
    const iconButtonStyle = { color: theme.node.muted };
    const settleDeleteConfirmation = (confirmed: boolean) => {
        const pending = pendingDeleteRef.current;
        if (!pending) return;
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        pending.resolve(confirmed);
    };

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    const commitSessions = (nextSessions: CanvasAssistantSession[], nextActiveSessionId = activeSessionIdRef.current) => {
        sessionsRef.current = nextSessions;
        activeSessionIdRef.current = nextActiveSessionId;
        onSessionsChange(nextSessions, nextActiveSessionId);
    };

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        commitSessions(sessionsRef.current.map((session) => (session.id === sessionId ? updater(session) : session)));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };

    const updateMessage = (sessionId: string, messageId: string, patch: Partial<CanvasAssistantMessage>) => {
        updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
            updatedAt: new Date().toISOString(),
        }));
    };

    const startChatSession = () => {
        setSelectedSkills([]);
        if (activeSession && activeSession.messages.length === 0) {
            commitSessions(sessionsRef.current, activeSession.id);
            return;
        }
        const session = createSession();
        commitSessions([session, ...sessionsRef.current], session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            commitSessions([session], session.id);
        } else {
            const currentActiveSessionId = activeSessionIdRef.current;
            commitSessions(next, currentActiveSessionId && ids.includes(currentActiveSessionId) ? next[0].id : currentActiveSessionId);
        }
        cleanupImages({ sessions: next });
        setCheckedChatIds((previous) => previous.filter((id) => !ids.includes(id)));
    };

    const clearSessions = () => {
        const session = createSession();
        commitSessions([session], session.id);
        setCheckedChatIds([]);
        setSelectedSkills([]);
        cleanupImages({ sessions: [session] });
    };

    const selectComposerSkill = (skill: CanvasAgentSkillSelection) => {
        const existingIndex = selectedSkills.findIndex((selected) => selected.id === skill.id && selected.source === skill.source);
        if (existingIndex >= 0) {
            setSelectedSkills(selectedSkills.map((selected, index) => (index === existingIndex ? skill : selected)));
            return;
        }
        if (selectedSkills.length >= MAX_CANVAS_AGENT_SKILLS) {
            appMessage.warning(`最多选择 ${MAX_CANVAS_AGENT_SKILLS} 个 Skill`);
            return;
        }
        setSelectedSkills([...selectedSkills, skill]);
    };

    const removeComposerSkill = (id: string, source: CanvasAgentSkillSelection["source"]) => {
        setSelectedSkills((current) => current.filter((skill) => skill.id !== id || skill.source !== source));
    };

    const sendMessage = async (text: string, savedReferences?: CanvasAssistantReference[], skillOverride?: CanvasAgentSkillSelection[] | null) => {
        const session = activeSession || createSession();
        const activeSkills = skillOverride !== undefined ? skillOverride || [] : selectedSkills.length ? selectedSkills : session.activeSkills || [];
        let activeSkillContents: Array<{ id: string; source: CanvasAgentSkillSelection["source"]; name: string; content: string; hasFiles?: boolean }> = [];

        if (activeSkills.length) {
            const skillStore = useAgentSkillStore.getState();
            if (!skillStore.systemSkills.length && !skillStore.userSkills.length) {
                try {
                    await skillStore.loadSkills();
                } catch (error) {
                    appMessage.error(error instanceof Error ? error.message : "Skill 加载失败");
                    return;
                }
            }
            const availableSkills = [...useAgentSkillStore.getState().systemSkills, ...useAgentSkillStore.getState().userSkills];
            const latestSkills = activeSkills.map((selected) => availableSkills.find((skill) => skill.id === selected.id && skill.source === selected.source && skill.enabled));
            const unavailableSkill = activeSkills.find((_, index) => !latestSkills[index]);
            if (unavailableSkill) {
                appMessage.error(`Skill「${unavailableSkill.name}」已不可用，请重新选择`);
                return;
            }
            activeSkillContents = latestSkills.map((skill) => ({ id: skill!.id, source: skill!.source, name: skill!.name, content: skill!.content, hasFiles: skill!.hasFiles }));
        }

        if (!activeSession) commitSessions([session], session.id);
        updateSession(session.id, (current) => ({
            ...current,
            activeSkills,
            updatedAt: new Date().toISOString(),
        }));

        const references = savedReferences || composerReferences;
        const messageReferenceNodeIds = references.map((reference) => reference.id);
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references, skills: activeSkills, skillsSelected: skillOverride === undefined && selectedSkills.length > 0, status: "success" };
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        appendMessage(session.id, { id: assistantId, role: "assistant", text: "", status: "thinking", activity: "正在理解画布和创作目标" });
        setPrompt("");
        setComposerReferenceIds([]);
        setSelectedSkills([]);
        setRemovedReferenceIds(new Set(selectedNodeIds));

        const requestConfig = {
            ...effectiveConfig,
            model: agentConfig.textModel || effectiveConfig.textModel || effectiveConfig.model,
            apiMode: agentConfig.textApiMode,
            activeChannelId: agentConfig.textChannelId || effectiveConfig.textChannelId || effectiveConfig.activeChannelId,
            textModel: agentConfig.textModel || effectiveConfig.textModel,
            textChannelId: agentConfig.textChannelId || effectiveConfig.textChannelId,
        };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            updateMessage(session.id, assistantId, {
                text: "全局文本模型尚未配置完成。请先从应用原有的全局配置入口选择文本模型和渠道，然后再继续。",
                status: "error",
                activity: undefined,
            });
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setIsRunning(true);
        try {
            const modelReferences = await Promise.all(
                references.map(async (reference) => {
                    if (!reference.dataUrl) return reference;
                    try {
                        return { ...reference, dataUrl: await imageToDataUrl(reference) };
                    } catch {
                        return reference;
                    }
                }),
            );
            const result = await runCanvasAgent({
                config: requestConfig,
                initialState: session.agentState,
                protocolMessages: session.protocolMessages,
                userText: text,
                references: modelReferences,
                activeSkillContents,
                contextCheckpoint: session.contextCheckpoint,
                getContext: getAgentContext,
                executeAction: async (action) => {
                    if (action.name === "read_skill_file") {
                        const skillId = typeof action.arguments.skillId === "string" ? action.arguments.skillId : "";
                        const filePath = typeof action.arguments.path === "string" ? action.arguments.path : "";
                        const activeSkill = activeSkills.find((skill) => skill.id === skillId && skill.source === "system");
                        if (!activeSkill) return { ok: false, code: "skill_not_active", message: "只能读取当前激活的系统 Skill 文件" };
                        try {
                            const file = await fetchSystemAgentSkillFile(skillId, filePath);
                            return { ok: true, skillId, path: file.path, content: file.content };
                        } catch (error) {
                            return { ok: false, code: "skill_file_not_found", message: error instanceof Error ? error.message : "Skill 文件读取失败" };
                        }
                    }
                    if (action.name !== "delete_node") return onExecuteAction(action, messageReferenceNodeIds);
                    const nodeId = typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : "";
                    const node = nodes.find((item) => item.id === nodeId);
                    const confirmed = await new Promise<boolean>((resolve) => {
                        const pending = { title: node?.title || "未命名节点", resolve };
                        pendingDeleteRef.current = pending;
                        setPendingDelete(pending);
                    });
                    return confirmed ? onExecuteAction(action, messageReferenceNodeIds) : { ok: false, code: "delete_cancelled", message: "用户取消删除，原节点已保留" };
                },
                signal: controller.signal,
                onEvent: (event) => updateMessage(session.id, assistantId, { status: event.status, activity: event.label }),
                onCheckpoint: (checkpoint) =>
                    updateSession(session.id, (current) => ({
                        ...current,
                        agentState: checkpoint.state,
                        protocolMessages: checkpoint.protocolMessages,
                        contextCheckpoint: checkpoint.contextCheckpoint,
                        updatedAt: new Date().toISOString(),
                    })),
            });
            updateSession(session.id, (current) => ({
                ...current,
                agentState: result.state,
                protocolMessages: result.protocolMessages,
                contextCheckpoint: result.contextCheckpoint,
                messages: current.messages.map((message) =>
                    message.id === assistantId ? { ...message, text: result.reply, status: "success", activity: undefined } : message,
                ),
                updatedAt: new Date().toISOString(),
            }));
        } catch (error) {
            const stopped = error instanceof Error && error.name === "AbortError";
            updateMessage(session.id, assistantId, {
                text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败",
                status: stopped ? "waiting" : "error",
                activity: undefined,
            });
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setIsRunning(false);
        }
    };

    useEffect(() => {
        if (!initialRequest || consumedInitialRequestRef.current === initialRequest) return;
        consumedInitialRequestRef.current = initialRequest;
        onInitialRequestConsumed?.();
        void sendMessage(initialRequest.prompt, initialRequest.references);
    }, [initialRequest, onInitialRequestConsumed]);

    const submit = async (nextPrompt = prompt, referenceIds = composerReferenceIds) => {
        const text = nextPrompt.trim();
        if (!text || isRunning) return;
        await sendMessage(text, resolveReferences(referenceIds));
    };

    const retryMessage = (message: CanvasAssistantMessage) => {
        const index = messages.findIndex((item) => item.id === message.id);
        const user = messages.slice(0, index).findLast((item) => item.role === "user");
        if (user) void sendMessage(user.text, user.references, user.skills || []);
    };

    const startResize = () => {
        const move = (event: MouseEvent) => onWidthChange(Math.min(760, Math.max(320, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        setClosing(true);
        onCollapseStart();
        window.setTimeout(onCollapse, PANEL_MOTION_MS);
    };

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                data-canvas-agent-panel
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Bot className="size-4" />
                        {view === "history" ? "历史记录" : "创作 Agent"}
                    </div>
                    <div className="flex items-center gap-1">
                        {view === "history" ? (
                            <>
                                <Tooltip title="删除选中">
                                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Trash2 className="size-4" />} disabled={!checkedChatIds.length} onClick={() => setDeleteChatIds(checkedChatIds)} />
                                </Tooltip>
                                <Tooltip title="删除全部">
                                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<X className="size-4" />} disabled={!historySessions.length} onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))} />
                                </Tooltip>
                            </>
                        ) : null}
                        <Tooltip title={view === "history" ? "返回对话" : "历史记录"}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<History className="size-4" />} onClick={() => setView(view === "history" ? "chat" : "history")} />
                        </Tooltip>
                        <Tooltip title="新对话">
                            <Button
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8"
                                style={iconButtonStyle}
                                icon={<Plus className="size-4" />}
                                disabled={!hasMessages}
                                onClick={() => {
                                    startChatSession();
                                    setView("chat");
                                }}
                            />
                        </Tooltip>
                        <Tooltip title="Agent 设置">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)} />
                        </Tooltip>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} />
                        </Tooltip>
                    </div>
                </div>

                <div ref={messageListRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            checkedIds={checkedChatIds.filter((id) => historySessions.some((session) => session.id === id))}
                            onToggleChecked={(id, checked) => setCheckedChatIds((previous) => (checked ? [...new Set([...previous, id])] : previous.filter((item) => item !== id)))}
                            onOpen={(id) => {
                                commitSessions(sessionsRef.current, id);
                                setSelectedSkills([]);
                                setView("chat");
                            }}
                            onDelete={(id) => setDeleteChatIds([id])}
                        />
                    ) : messages.length ? (
                        <AssistantMessages messages={messages} onRetry={retryMessage} />
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                            <div className="grid size-12 place-items-center rounded-2xl" style={{ background: theme.node.fill }}>
                                <Sparkles className="size-5" />
                            </div>
                            <div className="mt-4 text-base font-medium">从一个想法开始</div>
                            <div className="mt-2 max-w-[260px] text-sm leading-6 opacity-55">描述故事、宣传片或现有素材，Agent 会与你沟通并直接操作当前画布</div>
                        </div>
                    )}
                </div>

                {view === "chat" ? (
                    <>
                        {pendingDelete ? (
                            <div className="mx-2 mb-2 overflow-hidden rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                                <div className="min-w-0 px-3 py-2.5">
                                    <div className="truncate text-sm font-medium">删除「{pendingDelete.title}」？</div>
                                    <div className="mt-0.5 text-xs opacity-55">相关连线和任务记录将按现有逻辑清理</div>
                                </div>
                                <div className="grid grid-cols-2 border-t" style={{ borderColor: theme.node.stroke }}>
                                    <button type="button" className="h-9 cursor-pointer border-0 bg-transparent text-sm" style={{ color: theme.node.text }} onClick={() => settleDeleteConfirmation(false)}>取消</button>
                                    <button type="button" className="h-9 cursor-pointer border-0 border-l bg-transparent text-sm font-medium" style={{ borderColor: theme.node.stroke, color: "#ef4444" }} onClick={() => settleDeleteConfirmation(true)}>确认删除</button>
                                </div>
                            </div>
                        ) : null}
                        <CanvasAssistantComposer
                            prompt={prompt}
                            isRunning={isRunning}
                            references={composerReferences}
                            availableReferences={resourceReferences}
                            pendingReferences={pendingReferences}
                            selectedSkills={selectedSkills}
                            agentConfig={agentConfig}
                            onAgentConfigChange={onAgentConfigChange}
                            onPromptChange={setPrompt}
                            onSkillSelect={selectComposerSkill}
                            onSkillRemove={removeComposerSkill}
                            onReferenceIdsChange={(ids) => {
                                consumedReferenceNodeClickVersionRef.current = referenceNodeClick.version;
                                const removedSelectedIds = composerReferenceIds.filter((id) => selectedNodeIds.has(id) && !ids.includes(id));
                                if (removedSelectedIds.length) setRemovedReferenceIds((previous) => new Set([...previous, ...removedSelectedIds]));
                                setComposerReferenceIds(ids);
                            }}
                            onSubmit={submit}
                            onStop={() => {
                                settleDeleteConfirmation(false);
                                abortRef.current?.abort();
                            }}
                            onOpenUpload={onOpenUpload}
                            onOpenAssets={onOpenAssets}
                            onPasteImage={onPasteImage}
                        />
                    </>
                ) : null}

                <Modal
                    title="Agent 设置"
                    open={settingsOpen}
                    centered
                    width={520}
                    onCancel={() => setSettingsOpen(false)}
                    footer={<Button type="primary" onClick={() => setSettingsOpen(false)}>完成</Button>}
                >
                    <div className="flex items-center justify-between gap-6 py-2">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">自动生成图片/视频/音频</div>
                            <div className="mt-1 text-xs leading-5 opacity-55">开启后，Agent 可直接提交图片/视频/音频生成，无需再次确认</div>
                        </div>
                        <Switch checked={agentConfig.autoGenerateMedia} onChange={(autoGenerateMedia) => onAgentConfigChange({ autoGenerateMedia })} />
                    </div>
                </Modal>

                <Modal
                    title="删除对话记录？"
                    open={deleteChatIds.length > 0}
                    centered
                    onCancel={() => setDeleteChatIds([])}
                    footer={
                        <>
                            <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                            <Button
                                danger
                                type="primary"
                                onClick={() => {
                                    deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                    setDeleteChatIds([]);
                                }}
                            >
                                删除
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销</p>
                </Modal>
            </motion.aside>
        </motion.div>
    );
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4" />,
};

function AssistantMarkdown({ children }: { children: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className={cn(
                "min-w-0 whitespace-normal break-words",
                "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1:first-child]:mt-0",
                "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0",
                "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3:first-child]:mt-0",
                "[&_h4]:my-2 [&_h4]:font-semibold",
                "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
                "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--agent-markdown-border)] [&_blockquote]:pl-3 [&_blockquote]:opacity-80",
                "[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color:var(--agent-markdown-border)]",
                "[&_code]:rounded [&_code]:bg-[var(--agent-markdown-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
                "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--agent-markdown-surface)] [&_pre]:p-3",
                "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-[color:var(--agent-markdown-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-[color:var(--agent-markdown-border)] [&_td]:px-2 [&_td]:py-1.5",
            )}
            style={
                {
                    "--agent-markdown-surface": theme.toolbar.itemHover,
                    "--agent-markdown-border": theme.node.stroke,
                } as CSSProperties
            }
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MARKDOWN_COMPONENTS} skipHtml>
                {children}
            </ReactMarkdown>
        </div>
    );
}

function AssistantMessages({ messages, onRetry }: { messages: CanvasAssistantMessage[]; onRetry: (message: CanvasAssistantMessage) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const copyText = useCopyText();
    let previousUserSkills: CanvasAgentSkillSelection[] = [];

    return (
        <>
            {messages.map((message) => {
                const running = message.status === "thinking" || message.status === "running";
                const showSkills = message.skillsSelected ?? Boolean(message.skills?.length && !sameSkillSelections(message.skills, previousUserSkills));
                if (message.role === "user") previousUserSkills = message.skills || [];
                return (
                    <div key={message.id} className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")}>
                        {message.text ? (
                            <div
                                className="max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6"
                                style={
                                    message.role === "user"
                                        ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText }
                                        : message.status === "error"
                                            ? { background: theme.node.fill, color: theme.node.text }
                                            : { background: theme.node.fill, color: theme.node.text }
                                }
                            >
                                {message.role === "assistant" ? (
                                    <div className="mb-1 flex items-center gap-1.5 text-xs opacity-60">
                                        <Bot className="size-3.5" />
                                        Agent
                                    </div>
                                ) : null}
                                {message.role === "assistant" ? <AssistantMarkdown>{message.text}</AssistantMarkdown> : <UserMessageContent message={message} showSkills={showSkills} />}
                            </div>
                        ) : null}
                        {running ? <ImageGenerationPending compact label={message.activity || "正在执行"} className="w-[250px] rounded-2xl border" /> : null}
                        {!running && message.text ? (
                            <div className="flex gap-1">
                                <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<Copy className="size-3.5" />} onClick={() => copyText(message.text, "消息已复制")} title="复制" />
                                {message.role === "assistant" ? <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<RotateCcw className="size-3.5" />} onClick={() => onRetry(message)} title="重试" /> : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </>
    );
}

function AssistantHistory({
    sessions,
    activeSession,
    checkedIds,
    onToggleChecked,
    onOpen,
    onDelete,
}: {
    sessions: CanvasAssistantSession[];
    activeSession: CanvasAssistantSession | null;
    checkedIds: string[];
    onToggleChecked: (id: string, checked: boolean) => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-1">
            {sessions.map((session) => (
                <div key={session.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition" style={session.id === activeSession?.id ? { background: theme.node.fill } : undefined}>
                    <input type="checkbox" className="size-4" style={{ accentColor: theme.node.text }} checked={checkedIds.includes(session.id)} onChange={(event) => onToggleChecked(session.id, event.target.checked)} />
                    <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => onOpen(session.id)}>
                        <span className="block truncate">{session.title}</span>
                        <span className="text-xs opacity-50">{session.messages.length} 条消息</span>
                    </button>
                    <Button type="text" shape="circle" size="small" className="opacity-0 transition group-hover:opacity-100" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} title="删除" />
                </div>
            ))}
        </div>
    );
}

function UserMessageContent({ message, showSkills }: { message: CanvasAssistantMessage; showSkills: boolean }) {
    const references = useMemo(() => message.references?.map(assistantToPromptReference) || [], [message.references]);
    return <CanvasPromptChipInput value={message.text} references={references} skills={showSkills ? message.skills : undefined} onChange={ignorePromptChange} readOnly />;
}

function ignorePromptChange() {}

function sameSkillSelections(left: CanvasAgentSkillSelection[] = [], right: CanvasAgentSkillSelection[] = []) {
    return left.length === right.length && left.every((skill, index) => skill.id === right[index]?.id && skill.source === right[index]?.source);
}

function nodeToReference(node: CanvasNodeData, resource: CanvasResourceReference): CanvasAssistantReference | null {
    const content = assistantReferenceContentFromNode(node);
    return content ? { id: node.id, type: node.type, title: node.title, label: resource.label, ...content } : null;
}

function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return {
        id: nanoid(),
        title: "新对话",
        messages: [],
        agentState: createCanvasAgentState(),
        protocolMessages: [],
        createdAt: now,
        updatedAt: now,
    };
}
