"use client";

import {
    AlertCircle,
    BookOpen,
    CheckCircle2,
    CheckSquare,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    CloudUpload,
    Copy,
    Download,
    FolderPlus,
    History,
    ImagePlus,
    LoaderCircle,
    PanelBottom,
    PanelLeft,
    PenLine,
    Plus,
    RotateCcw,
    Sparkles,
    SlidersHorizontal,
    Trash2,
    Upload,
    WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Segmented, Tag, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel, imageFormatLabel, imageQualityLabel, imageSizeLabel, imageSizeOptions } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import {
    CreativeWorkflowWorkspace,
    type WorkflowExternalTaskFailure,
    type WorkflowExternalTaskStart,
    type WorkflowExternalTaskSuccess,
} from "@/components/workflows/creative-workflow-workspace";
import { modelChannelsForConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { ImageRequestError, batchCanvasImageTaskStatus, createCanvasImageTask, deleteCanvasImageTask, listCanvasImageTasks, requestEdit, requestGeneration, type CanvasImageTask } from "@/services/api/image";
import { deleteImageGenerationLogs, fetchImageGenerationLogs, saveImageGenerationLogs } from "@/services/api/generation-logs";
import { deleteStoredImages, imageToDataUrl, resolveImageUrl, uploadImage, uploadRemoteImageToServer } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { useGenerationConfirm } from "@/hooks/use-generation-confirm";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    taskLogId?: string;
    status: "pending" | "success" | "failed";
    createdAt: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    image?: GeneratedImage;
    error?: string;
    errorDetail?: string;
    durationMs?: number;
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    workflowTaskId?: string;
    task?: CanvasImageTask;
    progress?: number;
    lastPolledAt?: number;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "生成中" | "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
    errors: string[];
    errorDetails?: string[];
    categoryIds: string[];
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    workflowTaskId?: string;
    task?: CanvasImageTask;
    lastPolledAt?: number;
};

type GenerationLogConfig = Pick<AiConfig, "channelMode" | "model" | "imageModel" | "activeChannelId" | "imageChannelId" | "quality" | "size" | "count" | "apiMode" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli">;
type RequestSnapshot = { text: string; requestConfig: AiConfig; displayConfig: GenerationLogConfig; references: ReferenceImage[] };
type GenerationCategory = { id: string; name: string; createdAt: number };
type ResultViewMode = "all" | "category";

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type WorkbenchLayout = "side" | "bottom";
const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const WORKBENCH_LAYOUT_KEY = "infinite-canvas:image-workbench-layout";
const RESULT_VIEW_MODE_KEY = "infinite-canvas:image-result-view-mode";
const IMAGE_TASK_POLL_INTERVAL_MS = 10000;
const WORKFLOW_BUTTON_POSITION_KEY = "infinite-canvas:workflow-button-position";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });
export default function ImagePage() {
    const { message, modal } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const confirmGeneration = useGenerationConfirm();
    const addAsset = useAssetStore((state) => state.addAsset);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [uploadingCount, setUploadingCount] = useState(0);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [syncingImageIds, setSyncingImageIds] = useState<string[]>([]);
    const [categories, setCategories] = useState<GenerationCategory[]>([]);
    const [resultViewMode, setResultViewModeState] = useState<ResultViewMode>("all");
    const [activeResultCategoryId, setActiveResultCategoryId] = useState<string | null>(null);
    const [workbenchLayout, setWorkbenchLayoutState] = useState<WorkbenchLayout>("side");
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [workflowButtonPosition, setWorkflowButtonPosition] = useState({ x: 0, y: 0 });
    const workflowButtonRef = useRef<HTMLButtonElement>(null);
    const workflowButtonDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const accountHistorySyncEnabledRef = useRef(false);
    const saveLogChainRef = useRef<Promise<void>>(Promise.resolve());
    const pollingLogIdsRef = useRef(new Set<string>());
    const logsRef = useRef<GenerationLog[]>([]);
    const effectiveConfigRef = useRef(effectiveConfig);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const pendingCount = results.filter((item) => item.status === "pending").length;
    const pendingLogCount = logs.filter((log) => log.status === "生成中" && log.task && !log.images.length).length;
    const usesBackendImageTasks = (value: AiConfig) => value.channelMode === "remote" || (value.channelMode === "local" && Boolean(token));
    const imageTaskConfig = () => effectiveConfigRef.current;

    const restorePendingLogResults = (sourceLogs: GenerationLog[]) => {
        const pendingLogs = sourceLogs.filter((log) => log.status === "生成中" && log.task && !log.images.length);
        if (!pendingLogs.length) return;
        setResults((value) => mergePendingLogResults(value, pendingLogs));
    };

    const pollPendingLogsOnce = (sourceLogs: GenerationLog[]) => {
        const pendingLogs = sourceLogs.filter((log) => log.status === "生成中" && log.task && !log.images.length && !pollingLogIdsRef.current.has(log.id));
        if (!pendingLogs.length) return;
        void pollImageTaskLogsOnce(pendingLogs);
    };

    useEffect(() => {
        void refreshCategories();
        try {
            const storedLayout = window.localStorage?.getItem(WORKBENCH_LAYOUT_KEY);
            if (storedLayout === "side" || storedLayout === "bottom") setWorkbenchLayoutState(storedLayout);
            const storedViewMode = window.localStorage?.getItem(RESULT_VIEW_MODE_KEY);
            if (storedViewMode === "all" || storedViewMode === "category") setResultViewModeState(storedViewMode);
            const storedButtonPosition = JSON.parse(window.localStorage?.getItem(WORKFLOW_BUTTON_POSITION_KEY) || "null") as { x?: number; y?: number } | null;
            if (typeof storedButtonPosition?.x === "number" && typeof storedButtonPosition?.y === "number") setWorkflowButtonPosition(clampWorkflowButtonPosition(storedButtonPosition));
            else setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        } catch {
            // Local storage can be unavailable in restricted browser contexts.
            setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        }

        // 监听窗口大小变化，拉窄窗口时自动将工作流按钮实时 clamp 限制在可视区域内，杜绝越界
        const handleResize = () => {
            setWorkflowButtonPosition((current) => clampWorkflowButtonPosition(current));
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => {
        logsRef.current = logs;
    }, [logs]);


    useEffect(() => {
        if (token) accountHistorySyncEnabledRef.current = true;
    }, [token]);

    useEffect(() => {
        effectiveConfigRef.current = effectiveConfig;
    }, [effectiveConfig]);

    useEffect(() => {
        restorePendingLogResults(logs);
    }, [logs]);

    useEffect(() => {
        if (!isUserReady) return;
        if (token) {
            void loadAccountImageHistory(token).then((items) => syncBackendImageTasks(items || logsRef.current));
            return;
        }
        void refreshLogs().then((items) => syncBackendImageTasks(items));
    }, [isUserReady, token]);

    useEffect(() => {
        if (!pendingCount && !pendingLogCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [pendingCount, pendingLogCount]);

    useEffect(() => {
        if (!pendingLogCount) return;
        pollPendingLogsOnce(logsRef.current);
        const timer = window.setInterval(() => pollPendingLogsOnce(logsRef.current), IMAGE_TASK_POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [pendingLogCount]);

    const setWorkbenchLayout = (layout: WorkbenchLayout) => {
        setWorkbenchLayoutState(layout);
        try {
            window.localStorage?.setItem(WORKBENCH_LAYOUT_KEY, layout);
        } catch {
            // Keep the in-memory layout even when persistence is unavailable.
        }
    };

    const setResultViewMode = (mode: ResultViewMode) => {
        setResultViewModeState(mode);
        try {
            window.localStorage?.setItem(RESULT_VIEW_MODE_KEY, mode);
        } catch {
            // Keep current view in memory if persistence is blocked.
        }
    };

    const persistWorkflowButtonPosition = (position: { x: number; y: number }) => {
        const nextPosition = clampWorkflowButtonPosition(position);
        setWorkflowButtonPosition(nextPosition);
        try {
            window.localStorage?.setItem(WORKFLOW_BUTTON_POSITION_KEY, JSON.stringify(nextPosition));
        } catch {
            // Keep the drag position in memory when localStorage is unavailable.
        }
    };

    const handleWorkflowButtonPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition();
        workflowButtonDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y, moved: false };
    };

    const handleWorkflowButtonPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        
        // 直接更新 DOM 样式，免去顶层 React State 的庞大整页重绘 Layout 卡顿！
        const nextPos = clampWorkflowButtonPosition({ x: drag.originX + dx, y: drag.originY + dy });
        if (workflowButtonRef.current) {
            workflowButtonRef.current.style.left = `${nextPos.x}px`;
            workflowButtonRef.current.style.top = `${nextPos.y}px`;
        }
    };

    const handleWorkflowButtonPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const finalPos = clampWorkflowButtonPosition({ x: drag.originX + dx, y: drag.originY + dy });
        persistWorkflowButtonPosition(finalPos);
    };

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        setUploadingCount(imageFiles.length);
        const hideLoading = message.loading("正在上传参考图...", 0);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success("参考图上传成功");
        } catch (error) {
            message.error(error instanceof Error ? `上传参考图失败：${error.message}` : "上传参考图失败");
        } finally {
            hideLoading();
            setUploadingCount(0);
        }
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            setUploadingCount(blobs.length);
            const hideLoading = message.loading("正在上传并读取参考图...", 0);
            try {
                const nextReferences = await Promise.all(
                    blobs.map(async (blob, index) => {
                        const image = await uploadImage(blob);
                        return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "clipboard" as const, temporary: true };
                    }),
                );
                setReferences((value) => [...value, ...nextReferences]);
                message.success(`已成功上传并读取 ${nextReferences.length} 张参考图`);
            } finally {
                hideLoading();
                setUploadingCount(0);
            }
        } catch {
            message.error("剪切板里没有可读取的图片");
            setUploadingCount(0);
        }
    };

    const removeReference = async (id: string) => {
        const reference = references.find((item) => item.id === id);
        setReferences((value) => value.filter((ref) => ref.id !== id));
        if (!reference || !shouldDeleteReferenceFile(reference, logs, results)) {
            message.success("已从工作台移除参考图");
            return;
        }
        if (reference?.storageKey) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const pastePromptFromClipboard = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            setPrompt(text);
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    const clearPrompt = () => {
        setPrompt("");
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        if (!(await confirmGeneration(snapshot.requestConfig, snapshot.displayConfig.imageModel || snapshot.displayConfig.model, "图片生成"))) return;
        setPrompt("");
        await submitGenerationBatch(snapshot);
    };

    const retryLog = async (log: GenerationLog) => {
        const retryChannelId = imageTaskChannelId(log.task);
        const snapshot = buildRequestSnapshot({ promptText: log.prompt, referenceItems: log.references, taskCount: Number(log.config.count) || 1, configOverride: { ...log.config, ...(retryChannelId ? { imageChannelId: retryChannelId, activeChannelId: retryChannelId } : {}) } });
        if (!snapshot) return;
        if (!(await confirmGeneration(snapshot.requestConfig, snapshot.displayConfig.imageModel || snapshot.displayConfig.model, "图片生成"))) return;
        await submitGenerationBatch(snapshot);
    };

    const submitPersistentGenerationBatch = async (snapshot: RequestSnapshot) => {
        setPreviewLog(null);
        const taskCount = Math.max(1, Number(snapshot.displayConfig.count) || 1);
        const pendingLogs = Array.from({ length: taskCount }, (_, index) => {
            const id = nanoid();
            const clientTaskId = `client_image_task_${id}`;
            const task: CanvasImageTask = { id: clientTaskId, status: "queued", progress: 0, createdAt: Date.now().toString(), created_at: Date.now().toString() };
            return buildLog({
                id,
                prompt: snapshot.text,
                model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
                config: { ...snapshot.displayConfig, count: "1" },
                references: snapshot.references,
                durationMs: 0,
                successCount: 0,
                failCount: 0,
                status: "生成中",
                images: [],
                errors: [],
                errorDetails: [],
                categoryIds: activeResultCategoryId ? [activeResultCategoryId] : [],
                task,
                lastPolledAt: Date.now(),
            });
        });
        setResults((value) => mergePendingLogResults(value, pendingLogs));
        setNow(Date.now());

        const settled = await Promise.allSettled(pendingLogs.map((log, index) => createPersistentImageTask(log, snapshot, index, taskCount)));
        const createdCount = settled.filter((item) => item.status === "fulfilled").length;
        if (createdCount) message.success(`已创建 ${createdCount} 个图片任务`);
        if (createdCount < pendingLogs.length) message.warning(`${pendingLogs.length - createdCount} 个图片任务创建失败`);
    };

    const createPersistentImageTask = async (pendingLog: GenerationLog, snapshot: RequestSnapshot, index: number, taskCount: number) => {
        try {
            const task = await createCanvasImageTask(
                { ...snapshot.requestConfig, seedIndex: index, seedCount: taskCount, count: "1" } as AiConfig & { seedIndex?: number; seedCount?: number },
                snapshot.text,
                snapshot.references,
                { source: "image-workbench", sourceId: pendingLog.id, clientTaskId: imageLogTaskId(pendingLog) },
            );
            const nextLog = { ...pendingLog, task, lastPolledAt: Date.now() };
            await saveLog(nextLog);
            setResults((value) => updateResultByLogId(value, pendingLog.id, { taskLogId: nextLog.id, task, progress: task.progress, lastPolledAt: nextLog.lastPolledAt }));
            return nextLog;
        } catch (error) {
            const nextLog = { ...pendingLog, status: "失败" as const, durationMs: Date.now() - pendingLog.createdAt, failCount: 1, errors: [errorMessage(error)], errorDetails: [errorDetail(error)], lastPolledAt: Date.now() };
            await saveLog(nextLog);
            setResults((value) => updateResultByLogId(value, pendingLog.id, { status: "failed", error: nextLog.errors[0], errorDetail: nextLog.errorDetails?.[0], durationMs: nextLog.durationMs, lastPolledAt: nextLog.lastPolledAt }));
            throw error;
        }
    };
    const submitGenerationBatch = async (snapshot: RequestSnapshot) => {
        if (usesBackendImageTasks(snapshot.requestConfig)) {
            await submitPersistentGenerationBatch(snapshot);
            return;
        }
        setPreviewLog(null);
        const taskCount = Math.max(1, Number(snapshot.displayConfig.count) || 1);
        const taskIds = Array.from({ length: taskCount }, () => nanoid());
        const pendingTasks = taskIds.map((id) => createPendingResult(id, snapshot));
        setResults((value) => [...pendingTasks, ...value]);
        setNow(Date.now());

        const tasks = taskIds.map(async (id, index) => {
            const taskStartedAt = performance.now();
            try {
                const image = await runGenerationTask(id, {
                    ...snapshot,
                    requestConfig: {
                        ...snapshot.requestConfig,
                        seedIndex: index,
                        seedCount: taskCount,
                    } as any,
                });

                if (!image) {
                    throw new Error("接口没有返回图片");
                }

                const durableImage = {
                    ...image,
                    storageKey: "",
                };
                
                // 更新结果状态
                setResults((value) => updateResult(value, id, { image: durableImage }));
                
                // 立即保存单张成功日志
                await saveLog(
                    buildLog({
                        prompt: snapshot.text,
                        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
                        config: { ...snapshot.displayConfig, count: "1" },
                        references: snapshot.references,
                        durationMs: performance.now() - taskStartedAt,
                        successCount: 1,
                        failCount: 0,
                        status: "成功",
                        images: [durableImage],
                        errors: [],
                        errorDetails: [],
                        categoryIds: activeResultCategoryId ? [activeResultCategoryId] : [],
                    }),
                );
                message.success("图片已生成");
            } catch (err) {
                const errMsg = errorMessage(err);
                const errDetail = errorDetail(err);
                
                // 立即保存单张失败日志
                await saveLog(
                    buildLog({
                        prompt: snapshot.text,
                        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
                        config: { ...snapshot.displayConfig, count: "1" },
                        references: snapshot.references,
                        durationMs: performance.now() - taskStartedAt,
                        successCount: 0,
                        failCount: 1,
                        status: "失败",
                        images: [],
                        errors: [errMsg],
                        errorDetails: [errDetail],
                        categoryIds: activeResultCategoryId ? [activeResultCategoryId] : [],
                    }),
                );
                message.error(errMsg || "生成失败");
            } finally {
                // 任务完成，从进行中状态移除
                setResults((value) => value.filter((item) => item.id !== id));
            }
        });

        await Promise.allSettled(tasks);
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        try {
            const dataUrl = await imageToDataUrl(image);
            const response = await fetch(dataUrl || image.dataUrl);
            const blob = await response.blob();
            saveAs(blob, `image-${index + 1}.${imageExtension(image.mimeType || blob.type || dataUrl || image.dataUrl)}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        }
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        try {
            if (image.storageKey) {
                const url = await resolveImageUrl(image.storageKey, image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: image.mimeType || "image/png", dataUrl: url || image.dataUrl, storageKey: image.storageKey, source: "result", temporary: false }]);
            } else {
                const source = await imageToDataUrl(image);
                const stored = await uploadImage(source || image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: "result", temporary: false }]);
            }
            message.success("已加入参考图");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入参考图失败");
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = image.storageKey
            ? {
                  url: await resolveImageUrl(image.storageKey, image.dataUrl),
                  storageKey: image.storageKey,
                  width: image.width,
                  height: image.height,
                  bytes: image.bytes,
                  mimeType: image.mimeType || "image/png",
              }
            : await uploadImage(await imageToDataUrl(image));
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const syncImage = async (image: GeneratedImage, index: number) => {
        if (image.storageKey?.startsWith("server:") || syncingImageIds.includes(image.id)) return null;
        setSyncingImageIds((ids) => Array.from(new Set([...ids, image.id])));
        const hideLoading = message.loading("正在同步图片到云端存储...", 0);
        try {
            const uploaded = await uploadRemoteImageToServer(image.dataUrl, "image-" + (index + 1) + "." + imageExtension(image.mimeType || image.dataUrl));
            message.success("图片已同步到云端存储");
            return { ...image, dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width || image.width, height: uploaded.height || image.height, bytes: uploaded.bytes || image.bytes, mimeType: uploaded.mimeType || image.mimeType };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "";
            if (errorMessage.includes("服务端对象存储未启用") || errorMessage.includes("用户对象存储配置不完整")) {
                message.error("未添加云存储");
            } else {
                message.error(errorMessage || "图片同步失败");
            }
            return null;
        } finally {
            hideLoading();
            setSyncingImageIds((ids) => ids.filter((id) => id !== image.id));
        }
    };

    const syncResultImage = async (resultId: string, image: GeneratedImage, index: number) => {
        const synced = await syncImage(image, index);
        if (!synced) return;
        setResults((value) => updateResult(value, resultId, { image: synced }));
    };

    const syncLogImage = async (log: GenerationLog, image: GeneratedImage, index: number) => {
        const synced = await syncImage(image, index);
        if (!synced) return;
        const nextLog = { ...log, images: log.images.map((item) => item.id === image.id ? synced : item) };
        await logStore.setItem(log.id, serializeLog(nextLog));
        const nextLogs = logs.map((item) => item.id === log.id ? nextLog : item);
        setLogs(nextLogs);
        await persistImageHistory(nextLogs, categories);
        if (previewLog?.id === log.id) setPreviewLog(nextLog);
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const resolvedUrl = await resolveImageUrl(payload.storageKey, payload.dataUrl);
            const safeUrl = resolvedUrl || "";
            const reference =
                payload.storageKey || payload.source === "asset" || payload.source === "library"
                    ? {
                          id: nanoid(),
                          name: payload.title,
                          type: payload.mimeType || "image/png",
                          dataUrl: safeUrl,
                          storageKey: payload.storageKey,
                          source: payload.source === "library" ? "library" : "asset",
                          assetId: payload.assetId,
                          temporary: false,
                      }
                    : (() => null)();
            if (reference) {
                if (!reference.dataUrl) {
                    message.error("引入素材失败：图片数据为空");
                    return;
                }
                setReferences((value) => [...value, reference]);
            } else {
                const stored = await uploadImage(payload.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: payload.source === "library" ? "library" : "upload", temporary: payload.source !== "library" }]);
            }
        } else {
            message.warning("视频素材不能作为生图参考图");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults((value) => value.filter((item) => item.status === "pending"));
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteBackendImageTasks = async (items: GenerationLog[]) => {
        if (!token) return;
        const tasks = Array.from(
            new Map(
                items.flatMap((item) => {
                    const taskId = item.task?.parent_task_id || item.task?.id;
                    return item.task && taskId
                        ? [[taskId, { ...item.task, id: taskId }] as const]
                        : [];
                }),
            ).values(),
        );
        await Promise.all(tasks.map((task) => deleteCanvasImageTask(imageTaskConfig(), task).catch(() => undefined)));
    };

    const deleteAccountImageLogs = async (items: GenerationLog[]) => {
        if (!token) return;
        const ids = Array.from(new Set(items.flatMap((item) => [item.id, item.task?.id].filter((id): id is string => Boolean(id)))));
        if (!ids.length) return;
        await deleteImageGenerationLogs(token, ids).catch(() => undefined);
    };

    const deleteSelectedLogs = () => {
        const deletedLogs = logs.filter((log) => selectedLogIds.includes(log.id));
        const nextLogs = logs.filter((log) => !selectedLogIds.includes(log.id));
        const imageKeys = disposableLogStorageKeys(deletedLogs, nextLogs);
        void Promise.all([deleteBackendImageTasks(deletedLogs), deleteAccountImageLogs(deletedLogs), deleteStoredImages(imageKeys), ...deletedLogs.map((log) => logStore.removeItem(log.id))]).then(async () => {
            setLogs(nextLogs);
            setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
            await persistImageHistory(nextLogs, categories);
            await refreshLogs();
        });
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults((value) => value.filter((item) => item.status === "pending"));
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const deleteLog = (log: GenerationLog) => {
        modal.confirm({
            title: "删除生成结果",
            content: "确定删除这条生成结果吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextLogs = logs.filter((item) => item.id !== log.id);
                const imageKeys = disposableLogStorageKeys([log], nextLogs);
                await Promise.all([deleteBackendImageTasks([log]), deleteAccountImageLogs([log]), deleteStoredImages(imageKeys), logStore.removeItem(log.id)]);
                setLogs(nextLogs);
                setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
                await persistImageHistory(nextLogs, categories);
                setSelectedLogIds((value) => value.filter((id) => id !== log.id));
                if (previewLog?.id === log.id) setPreviewLog(null);
                await refreshLogs();
            },
        });
    };

    const persistLoggedOutLogImages = async (log: GenerationLog): Promise<GenerationLog> => {
        const images = log.images || [];
        if (!images.some((image) => !image.storageKey && image.dataUrl?.startsWith("data:image/"))) return log;
        const persistedImages = await Promise.all(
            images.map(async (image) => {
                if (image.storageKey || !image.dataUrl?.startsWith("data:image/")) return image;
                try {
                    const stored = await uploadImage(image.dataUrl, { localOnly: true });
                    return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width || image.width, height: stored.height || image.height, bytes: stored.bytes || image.bytes, mimeType: stored.mimeType || image.mimeType };
                } catch {
                    return image;
                }
            }),
        );
        return { ...log, images: persistedImages };
    };

    const saveLog = async (log: GenerationLog) => {
        const persistedLog = token ? log : await persistLoggedOutLogImages(log);
        const prevChain = saveLogChainRef.current;
        const nextChain = (async () => {
            try {
                await prevChain;
            } catch {
                // Ignore previous errors so the chain doesn't break permanently
            }
            const storedLogs = await readStoredLogs();
            const keys = new Set(imageLogIdentityKeys(log));
            const duplicateLogs = storedLogs.filter((item) => item.id !== log.id && imageLogIdentityKeys(item).some((key) => keys.has(key)));
            const nextLogs = dedupeGenerationLogs([persistedLog, ...storedLogs.filter((item) => item.id !== log.id)]);
            setLogs(nextLogs);
            await Promise.all(duplicateLogs.map((item) => logStore.removeItem(item.id)));
            await logStore.setItem(log.id, serializeLog(persistedLog));
            await persistImageHistory(nextLogs, categories);
        })();
        saveLogChainRef.current = nextChain;
        await nextChain;
    };

    const refreshLogs = async () => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        return nextLogs;
    };
    const refreshCategories = async () => setCategories(await readStoredCategories());

    const loadAccountImageHistory = async (currentToken: string) => {
        try {
            accountHistorySyncEnabledRef.current = true;
            const localLogs = await readStoredLogs();
            const storedCategories = await readStoredCategories();
            const remoteLogs = await fetchImageGenerationLogs<GenerationLog>(currentToken);
            const mergedLogs = await mergeGenerationLogs(remoteLogs, localLogs);
            const categorized = withWorkflowLogCategories(mergedLogs, storedCategories);
            await replaceStoredImageHistory(categorized.logs, categorized.categories);
            setCategories(categorized.categories);
            setLogs(categorized.logs);
            return categorized.logs;
        } catch {
            // Keep local history available when account sync fails.
            return undefined;
        }
    };

    const persistImageHistory = async (nextLogs: GenerationLog[], _nextCategories: GenerationCategory[]) => {
        if (!token || !accountHistorySyncEnabledRef.current) return;
        await saveImageGenerationLogs(token, nextLogs.map(serializeLog)).catch(() => {
            accountHistorySyncEnabledRef.current = false;
        });
    };

    const syncBackendImageTasks = async (baseLogs?: GenerationLog[]) => {
        const currentConfig = imageTaskConfig();
        if (!token) return baseLogs || logsRef.current;
        try {
            const tasks = await listCanvasImageTasks(currentConfig, ["image-workbench", "workflow"]);
            const recoverableTasks = tasks.filter(isRecoverableImageTask);
            if (!recoverableTasks.length) return baseLogs || logsRef.current;
            const currentLogs = baseLogs || (await readStoredLogs());
            const mergedLogs = mergeBackendImageTasks(currentLogs, recoverableTasks, currentConfig);
            const taskIds = new Set(recoverableTasks.flatMap(imageTaskIdentityKeys));
            const recoveredLogs = mergedLogs.filter((log) => imageLogIdentityKeys(log).some((key) => taskIds.has(key)));
            await Promise.all(recoveredLogs.map((log) => logStore.setItem(log.id, serializeLog(log))));
            setLogs(mergedLogs);
            setResults((value) => mergePendingLogResults(value, recoveredLogs));
            return mergedLogs;
        } catch {
            return baseLogs || logsRef.current;
        }
    };

    const pollImageTaskLogsOnce = async (pendingLogs: GenerationLog[]) => {
        const ids = pendingLogs.map(imageLogTaskId).filter(Boolean);
        if (!ids.length) return;
        pendingLogs.forEach((log) => pollingLogIdsRef.current.add(log.id));
        try {
            const tasks = await batchCanvasImageTaskStatus(imageTaskConfig(), ids);
            const taskById = new Map(tasks.map((task) => [task.id, task]));
            await Promise.all(
                pendingLogs.map(async (log) => {
                    const task = taskById.get(imageLogTaskId(log));
                    if (!task) {
                        const nextLog = { ...log, status: "失败" as const, durationMs: Date.now() - log.createdAt, failCount: 1, errors: ["图片任务不存在或未创建成功"], errorDetails: ["后端没有找到对应的图片任务"], lastPolledAt: Date.now() };
                        await saveLog(nextLog);
                        setResults((value) => updateResultByLogId(value, log.id, { status: "failed", error: nextLog.errors[0], errorDetail: nextLog.errorDetails?.[0], durationMs: nextLog.durationMs, lastPolledAt: nextLog.lastPolledAt }));
                        return;
                    }
                    if ((task.image_urls?.length || 0) > 1) {
                        const nextLogs = imageLogsFromTask(log, task);
                        await Promise.all(nextLogs.map(saveLog));
                        setResults((value) => value.filter((item) => !imageResultMatchesLog(item, nextLogs[0])));
                        return;
                    }

                    const nextLog = imageLogFromTask(log, task);
                    await saveLog(nextLog);
                    if (nextLog.status === "生成中") {
                        setResults((value) => updateResultByLogId(value, log.id, { task, progress: task.progress, durationMs: nextLog.durationMs, lastPolledAt: nextLog.lastPolledAt }));
                    } else {
                        setResults((value) => value.filter((item) => !imageResultMatchesLog(item, nextLog)));
                    }
                }),
            );
        } finally {
            pendingLogs.forEach((log) => pollingLogIdsRef.current.delete(log.id));
        }
    };

    const createCategory = async (name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return null;
        }
        const existing = categories.find((item) => item.name === trimmedName);
        if (existing) return existing;
        const nextCategory = { id: nanoid(), name: trimmedName, createdAt: Date.now() };
        const nextCategories = [...categories, nextCategory];
        setCategories(nextCategories);
        await categoryStore.setItem(CATEGORY_STORE_KEY, nextCategories);
        await persistImageHistory(logs, nextCategories);
        return nextCategory;
    };

    const renameCategory = async (category: GenerationCategory, name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return;
        }
        const nextCategories = categories.map((item) => (item.id === category.id ? { ...item, name: trimmedName } : item));
        setCategories(nextCategories);
        await categoryStore.setItem(CATEGORY_STORE_KEY, nextCategories);
        await persistImageHistory(logs, nextCategories);
        message.success("已重命名分类");
    };

    const deleteCategory = (category: GenerationCategory) => {
        modal.confirm({
            title: "删除分类",
            content: `确定删除分类「${category.name}」吗？分类内的生成结果会移至未分类。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextCategories = categories.filter((item) => item.id !== category.id);
                const nextLogs = logs.map((log) => ({ ...log, categoryIds: log.categoryIds.filter((id) => id !== category.id) }));
                setCategories(nextCategories);
                setLogs(nextLogs);
                await categoryStore.setItem(CATEGORY_STORE_KEY, nextCategories);
                await Promise.all(nextLogs.map((log) => logStore.setItem(log.id, serializeLog(log))));
                await persistImageHistory(nextLogs, nextCategories);
                message.success("已删除分类");
            },
        });
    };

    const updateLogCategories = async (log: GenerationLog, categoryIds: string[]) => {
        const nextLog = { ...log, categoryIds };
        const nextLogs = logs.map((item) => (item.id === log.id ? nextLog : item));
        setLogs(nextLogs);
        await logStore.setItem(log.id, serializeLog(nextLog));
        await persistImageHistory(nextLogs, categories);
        await refreshLogs();
        message.success(categoryIds.length ? "已更新分类" : "已移至未分类");
    };

    const toggleLogCategory = async (log: GenerationLog, categoryId: string) => {
        const nextCategoryIds = log.categoryIds.includes(categoryId) ? log.categoryIds.filter((id) => id !== categoryId) : [...log.categoryIds, categoryId];
        await updateLogCategories(log, nextCategoryIds);
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        const nextModel = log.config.imageModel || log.model;
        const nextChannelId = resolveImageChannelId(effectiveConfig, nextModel, imageTaskChannelId(log.task), log.config.imageChannelId, log.config.activeChannelId);
        if (nextModel) updateConfig("imageModel", nextModel);
        if (nextChannelId) {
            updateConfig("imageChannelId", nextChannelId);
            updateConfig("activeChannelId", nextChannelId);
        }
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        if (log.config.apiMode) updateConfig("apiMode", log.config.apiMode);
        if (typeof log.config.streamImages === "boolean") updateConfig("streamImages", log.config.streamImages);
        if (log.config.streamPartialImages) updateConfig("streamPartialImages", log.config.streamPartialImages);
        if (typeof log.config.responseFormatB64Json === "boolean") updateConfig("responseFormatB64Json", log.config.responseFormatB64Json);
        if (typeof log.config.codexCli === "boolean") updateConfig("codexCli", log.config.codexCli);
    };

    const copyPrompt = async (text: string) => {
        await navigator.clipboard.writeText(text);
        message.success("提示词已复制");
    };

    const buildRequestSnapshot = ({ promptText = prompt, referenceItems = references, taskCount = generationCount, configOverride }: { promptText?: string; referenceItems?: ReferenceImage[]; taskCount?: number; configOverride?: Partial<GenerationLogConfig> } = {}) => {
        const text = promptText.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        const baseConfig = { ...effectiveConfig, ...configOverride };
        const requestModel = configOverride?.imageModel || configOverride?.model || model;
        const requestChannelId = resolveImageChannelId(baseConfig, requestModel, configOverride?.imageChannelId, configOverride?.activeChannelId, baseConfig.imageChannelId, baseConfig.activeChannelId);
        if (!isAiConfigReady(baseConfig, requestModel)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        const requestConfig = { ...baseConfig, model: requestModel, imageModel: requestModel, activeChannelId: requestChannelId, imageChannelId: requestChannelId, count: "1" };
        return {
            text,
            requestConfig,
            displayConfig: buildGenerationLogConfig({ ...requestConfig, count: String(taskCount) }),
            references: [...referenceItems],
        };
    };

    const runGenerationTask = async (resultId: string, snapshot: RequestSnapshot) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.requestConfig, snapshot.text, snapshot.references) : await requestGeneration(snapshot.requestConfig, snapshot.text);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage: GeneratedImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl), mimeType: meta.mimeType };
            setResults((value) => updateResult(value, resultId, { status: "success", image: nextImage, durationMs: nextImage.durationMs }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResult(value, resultId, { status: "failed", error: errorMessage(error), errorDetail: errorDetail(error), durationMs: performance.now() - itemStartedAt }));
            throw error;
        }
    };

    const retryResult = async (result: GenerationResult) => {
        const retryChannelId = imageTaskChannelId(result.task);
        const snapshot = buildRequestSnapshot({ promptText: result.prompt, referenceItems: result.references, taskCount: 1, configOverride: { ...result.config, ...(retryChannelId ? { imageChannelId: retryChannelId, activeChannelId: retryChannelId } : {}) } });
        if (!snapshot) return;
        if (!(await confirmGeneration(snapshot.requestConfig, snapshot.displayConfig.imageModel || snapshot.displayConfig.model, "图片生成"))) return;
        setResults((value) => value.filter((item) => item.id !== result.id));
        await submitGenerationBatch(snapshot);
    };

    const handleWorkflowTaskStarted = (task: WorkflowExternalTaskStart) => {
        if (usesBackendImageTasks(effectiveConfig)) {
            setResultViewMode("all");
            setActiveResultCategoryId(null);
            return;
        }
        const configSnapshot = buildGenerationLogConfig({
            ...effectiveConfig,
            ...task.config,
            model: task.model,
            imageModel: task.model,
            apiMode: task.apiMode,
            count: String(task.count),
        });
        const pendingItems: GenerationResult[] = Array.from({ length: task.count }, (_, index) => ({
            id: createWorkflowResultId(task.taskId, index),
            status: "pending",
            createdAt: task.startedAt,
            prompt: task.prompt,
            model: task.model,
            config: configSnapshot,
            references: task.references || [],
            workflowId: task.workflowId,
            workflowName: task.workflowName,
            workflowInputs: task.inputs,
            workflowTaskId: task.taskId,
        }));
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        setResults((value) => [...pendingItems, ...value]);
        setNow(Date.now());
    };

    const handleWorkflowTaskSuccess = (task: WorkflowExternalTaskSuccess) => {
        setResults((value) => {
            const next = [...value];
            task.images.forEach((image, index) => {
                const resultId = createWorkflowResultId(task.taskId, index);
                const existingIndex = next.findIndex((item) => item.id === resultId);
                const nextImage: GeneratedImage = {
                    id: image.id,
                    dataUrl: image.imageUrl,
                    storageKey: image.storageKey,
                    durationMs: image.durationMs || task.durationMs,
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                };
                if (existingIndex >= 0) {
                    next[existingIndex] = { ...next[existingIndex], status: "success", image: nextImage, durationMs: task.durationMs };
                } else {
                    next.unshift({
                        id: resultId,
                        status: "success",
                        createdAt: task.endedAt,
                        prompt: image.prompt,
                        model: effectiveConfig.imageModel || effectiveConfig.model,
                        config: buildGenerationLogConfig(effectiveConfig),
                        references: [],
                        image: nextImage,
                        durationMs: task.durationMs,
                        workflowId: image.workflowId,
                        workflowName: image.workflowName,
                        workflowTaskId: task.taskId,
                    });
                }
            });
            return next;
        });
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        void Promise.all([refreshLogs(), refreshCategories()]).then(() => {
            setResults((value) => value.filter((item) => item.workflowTaskId !== task.taskId));
        });
    };

    const handleWorkflowTaskFailure = (task: WorkflowExternalTaskFailure) => {
        setResults((value) =>
            value.map((item) =>
                item.workflowTaskId === task.taskId
                    ? {
                          ...item,
                          status: "failed",
                          error: task.error,
                          durationMs: task.durationMs,
                      }
                    : item,
            ),
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className={`${workbenchLayout === "side" ? "grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]" : "relative flex flex-col"} min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:overflow-hidden`}>
                {workbenchLayout === "side" ? (
                    <>
                        <WorkbenchPanel
                            layout="side"
                            currentLayout={workbenchLayout}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={clearPrompt}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            uploadingCount={uploadingCount}
                        />
                        <ResultsPanel
                            results={results}
                            logs={logs}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onCreateSession={createSession}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onSaveAsset={saveResultToAssets}
                            syncingImageIds={syncingImageIds}
                            onSyncResult={syncResultImage}
                            onSyncLog={syncLogImage}
                            onRetry={retryResult}
                        />
                    </>
                ) : (
                    <>
                        <ResultsPanel
                            className="min-h-[360px] flex-1 pb-40 lg:pb-44"
                            results={results}
                            logs={logs}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onCreateSession={createSession}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onSaveAsset={saveResultToAssets}
                            syncingImageIds={syncingImageIds}
                            onSyncResult={syncResultImage}
                            onSyncLog={syncLogImage}
                            onRetry={retryResult}
                        />
                        <WorkbenchPanel
                            layout="bottom"
                            currentLayout={workbenchLayout}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={clearPrompt}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            uploadingCount={uploadingCount}
                        />
                    </>
                )}
            </main>
            <button
                ref={workflowButtonRef}
                type="button"
                className="fixed z-50 inline-flex touch-none select-none items-center gap-2 rounded-full border border-sky-300/70 bg-white/90 px-4 py-3 text-sm font-semibold text-stone-950 shadow-[0_18px_50px_rgba(14,165,233,0.28),0_8px_18px_rgba(0,0,0,0.14)] ring-1 ring-white/70 backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-sky-300 hover:bg-white hover:shadow-[0_22px_64px_rgba(14,165,233,0.36),0_10px_22px_rgba(0,0,0,0.18)] dark:border-sky-400/40 dark:bg-stone-900/88 dark:text-stone-100 dark:ring-white/10 dark:hover:bg-stone-900"
                style={{
                    left: (typeof window === "undefined" ? defaultWorkflowButtonPosition() : clampWorkflowButtonPosition(workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition())).x,
                    top: (typeof window === "undefined" ? defaultWorkflowButtonPosition() : clampWorkflowButtonPosition(workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition())).y
                }}
                onPointerDown={handleWorkflowButtonPointerDown}
                onPointerMove={handleWorkflowButtonPointerMove}
                onPointerUp={handleWorkflowButtonPointerUp}
                onClick={() => {
                    if (workflowButtonDragRef.current?.moved) {
                        workflowButtonDragRef.current = null;
                        return;
                    }
                    workflowButtonDragRef.current = null;
                    setWorkflowDrawerOpen(true);
                }}
            >
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.9)]" />
                <WandSparkles className="size-4 text-sky-500 dark:text-sky-300" />
                工作流
            </button>
            <Drawer title="创作工作流" placement="right" size="min(1120px, 92vw)" open={workflowDrawerOpen}  onClose={() => setWorkflowDrawerOpen(false)} styles={{ body: { padding: 0 } }} destroyOnHidden={false}>
                <CreativeWorkflowWorkspace
                    embedded
                    hideTaskList
                    onWorkflowTaskStarted={handleWorkflowTaskStarted}
                    onWorkflowTaskSuccess={handleWorkflowTaskSuccess}
                    onWorkflowTaskFailure={handleWorkflowTaskFailure}
                    onGenerationLogSaved={() => {
                        void (async () => {
                            const nextCategories = await readStoredCategories();
                            const nextLogs = await readStoredLogs();
                            setCategories(nextCategories);
                            setLogs(nextLogs);
                            await persistImageHistory(nextLogs, nextCategories);
                        })();
                    }}
                />
            </Drawer>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

const quickQualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];

function WorkbenchPanel({
    layout,
    currentLayout,
    prompt,
    references,
    config,
    model,
    canGenerate,
    pendingCount,
    updateConfig,
    openConfigDialog,
    onLayoutChange,
    onPromptChange,
    onOpenPromptLibrary,
    onOpenAssetPicker,
    onPastePrompt,
    onClearPrompt,
    onPasteReferences,
    onUploadReferences,
    onRemoveReference,
    onGenerate,
    uploadingCount,
}: {
    layout: WorkbenchLayout;
    currentLayout: WorkbenchLayout;
    prompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    canGenerate: boolean;
    pendingCount: number;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onPromptChange: (value: string) => void;
    onOpenPromptLibrary: () => void;
    onOpenAssetPicker: () => void;
    onPastePrompt: () => void;
    onClearPrompt: () => void;
    onPasteReferences: () => void;
    onUploadReferences: () => void;
    onRemoveReference: (id: string) => void;
    onGenerate: () => void;
    uploadingCount: number;
}) {
    const [bottomSettingsCollapsed, setBottomSettingsCollapsed] = useState(true);

    if (layout === "bottom") {
        return (
            <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-5 sm:bottom-7 sm:px-10 lg:px-16">
                <div className="pointer-events-auto w-full max-w-5xl rounded-[24px] bg-white/65 p-4 shadow-[0_32px_100px_rgba(15,23,42,.22),0_10px_34px_rgba(15,23,42,.10)] ring-1 ring-white/50 backdrop-blur-2xl dark:bg-stone-950/60 dark:ring-white/10 dark:shadow-[0_34px_110px_rgba(0,0,0,.58)]">
                    <div className="flex flex-col gap-3">
                        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                            <Input.TextArea
                                value={prompt}
                                onChange={(event) => onPromptChange(event.target.value)}
                                placeholder="描述你想生成的图片，可输入 @ 来指定参考图..."
                                autoSize={{ minRows: 2, maxRows: 4 }}
                                className="rounded-2xl"
                                onPressEnter={(event) => {
                                    if (!event.shiftKey && canGenerate) onGenerate();
                                }}
                            />
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                <Button title="清空输入" icon={<Trash2 className="size-4" />} onClick={onClearPrompt} />
                                <Button title="提示词库" icon={<BookOpen className="size-4" />} onClick={onOpenPromptLibrary} />
                                <Button title="我的素材" icon={<FolderPlus className="size-4" />} onClick={onOpenAssetPicker} />
                                <Button
                                    title="参数配置"
                                    className={`lg:hidden ${!bottomSettingsCollapsed ? "!bg-sky-500/10 !text-sky-500 !border-sky-500/30" : ""}`}
                                    icon={<SlidersHorizontal className="size-4" />}
                                    onClick={() => setBottomSettingsCollapsed(!bottomSettingsCollapsed)}
                                />
                                <Button title="切换到侧边工作台" icon={<PanelLeft className="size-4" />} onClick={() => onLayoutChange("side")} />
                                <Button type="primary" className="h-9 rounded-xl lg:!hidden font-medium px-4" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                    {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                                </Button>
                            </div>
                        </div>
                        <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[1.3fr_1.1fr_0.9fr_0.9fr_0.9fr_0.85fr_0.8fr_0.8fr_auto_auto] ${bottomSettingsCollapsed ? "hidden lg:grid" : "grid"}`}>
                            <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
                                模型
                                <ModelPicker
                                    config={config}
                                    value={model}
                                    capability="image"
                                    channelId={config.imageChannelId}
                                    onChange={(value, channelId) => {
                                        updateConfig("imageModel", value);
                                        if (channelId) updateConfig("imageChannelId", channelId);
                                    }}
                                    className="canvas-compact-control !h-11 !rounded-xl"
                                    onMissingConfig={() => openConfigDialog(false)}
                                    fullWidth
                                />
                            </label>
                            <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
                                接口模式
                                <div className="flex h-11 items-center rounded-xl border border-stone-200 bg-background px-2.5 dark:border-stone-800">
                                    <Segmented
                                        size="small"
                                        className="canvas-config-mode !rounded-md !p-0.5 w-full"
                                        value={config.apiMode}
                                        onChange={(value) => updateConfig("apiMode", value as "images" | "responses" | "chat")}
                                        options={[
                                            { value: "images", label: "images" },
                                            { value: "responses", label: "responses" },
                                            { value: "chat", label: "chat" },
                                        ]}
                                    />
                                </div>
                            </label>
                            <QuickSelect label="尺寸" value={config.size || "auto"} options={imageSizeOptions} onChange={(value) => updateConfig("size", value)} />
                            <QuickSelect label="质量" value={config.quality || "auto"} options={quickQualityOptions} onChange={(value) => updateConfig("quality", value)} />
                            <QuickNumber label="数量" value={config.count || "1"} min={1} max={10} onChange={(value) => updateConfig("count", value)} />
                            <ReferenceQuickActions references={references} onUploadReferences={onUploadReferences} />
                            <Button type="primary" className="h-11 min-w-28 rounded-xl hidden lg:inline-flex" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                            </Button>
                        </div>
                        {references.length || uploadingCount > 0 ? <ReferenceStrip className="mt-3" references={references} compact onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} /> : null}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 p-4 pb-3">
                <WorkbenchHeader currentLayout={currentLayout} summary={settingsSummary(config, model)} onLayoutChange={onLayoutChange} />
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
                <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                    <div className="px-3 py-2">
                        <span className="font-medium text-sm">提示词</span>
                    </div>
                    <div className="border-t border-stone-200 p-3 dark:border-stone-800 space-y-2">
                        <div className="flex flex-wrap gap-1">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPastePrompt}>读取剪贴板</Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={onClearPrompt}>清空</Button>
                            <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={onOpenPromptLibrary}>提示词库</Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>我的素材</Button>
                        </div>
                        <Input.TextArea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={6} placeholder="描述画面主体、风格、构图、光线和用途" />
                    </div>
                </section>

                <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                    <div className="flex items-center gap-2 px-3 py-2">
                        <span className="font-medium text-sm">参考图</span>
                        <Tag className="m-0 text-xs">{references.length}</Tag>
                    </div>
                    <div className="border-t border-stone-200 p-3 dark:border-stone-800 space-y-2">
                        <div className="flex flex-wrap gap-1">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences}>剪切板</Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={onUploadReferences}>上传</Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>从素材库选择</Button>
                        </div>
                        <ReferenceStrip references={references} onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} />
                    </div>
                </section>

                <div className="space-y-3">
                    <GenerationSettings config={config} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                    {pendingCount ? `继续提交（${pendingCount} 个生成中）` : "开始生成"}
                </Button>
            </div>
        </div>
    );
}

function WorkbenchHeader({ currentLayout, summary, onLayoutChange, compact = false }: { currentLayout: WorkbenchLayout; summary?: string; onLayoutChange: (layout: WorkbenchLayout) => void; compact?: boolean }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
                <h1 className={`${compact ? "text-base" : "text-2xl"} font-semibold text-stone-950 dark:text-stone-100`}>生图工作台</h1>
                {summary ? <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{summary}</p> : null}
            </div>
            <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                <Button size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>
                    侧边
                </Button>
                <Button size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>
                    底部
                </Button>
            </div>
        </div>
    );
}

function ReferenceStrip({ references, compact = false, className = "", onRemoveReference, uploadingCount = 0 }: { references: ReferenceImage[]; compact?: boolean; className?: string; onRemoveReference: (id: string) => void; uploadingCount?: number }) {
    return (
        <div
            className={`hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 overscroll-x-contain dark:border-stone-700 ${compact ? "min-h-14" : "min-h-24 pb-3"} ${className}`}
            onWheel={(event) => {
                if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                event.preventDefault();
                event.currentTarget.scrollLeft += event.deltaY;
            }}
        >
            {references.map((item) => (
                <div key={item.id} className={`${compact ? "size-12" : "size-20"} group relative shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800`}>
                    <Image
                        src={item.dataUrl || undefined}
                        alt={item.name}
                        className="size-full object-cover cursor-pointer"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        preview={{
                            mask: "点击预览",
                        }}
                    />
                    <button type="button" className="absolute right-1 top-1 hidden z-10 size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label="移除参考图">
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ))}
            {Array.from({ length: uploadingCount }).map((_, i) => (
                <div key={`loading-${i}`} className={`${compact ? "size-12" : "size-20"} shrink-0 flex items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-stone-100/50 dark:bg-stone-900/50`}>
                    <LoaderCircle className="size-5 animate-spin text-stone-400" />
                </div>
            ))}
            {!references.length && !uploadingCount ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
        </div>
    );
}

function ReferenceQuickActions({ references, onUploadReferences }: { references: ReferenceImage[]; onUploadReferences: () => void }) {
    return (
        <div className="flex h-11 items-center gap-1 rounded-xl border border-stone-200 bg-background px-2 dark:border-stone-800">
            {references[0] ? <img src={references[0].dataUrl || undefined} alt={references[0].name} className="size-7 rounded object-cover" /> : null}
            {references.length ? <span className="min-w-7 text-xs text-stone-500">{references.length} 张</span> : null}
            <Button size="small" type="text" icon={<Upload className="size-3.5" />} onClick={onUploadReferences} />
        </div>
    );
}

function QuickSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <select className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((item) => (
                    <option key={item.value} value={item.value}>
                        {item.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function QuickNumber({ label, value, min, max, disabled, onChange }: { label: string; value: string; min: number; max: number; disabled?: boolean; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <input
                className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none disabled:opacity-50 dark:border-stone-800 dark:text-stone-100"
                type="number"
                min={min}
                max={max}
                disabled={disabled}
                value={value}
                onChange={(event) => onChange(String(Math.max(min, Math.min(max, Number(event.target.value) || min))))}
            />
        </label>
    );
}

function settingsSummary(config: AiConfig, model: string) {
    return [
        model,
        config.apiMode === "chat" ? "Chat" : config.apiMode === "responses" ? "Responses" : "Images",
        imageSizeLabel(config.size || "auto"),
        imageQualityLabel(config.quality || "auto"),
        `${config.count || "1"} 张`,
    ].join(" · ");
}

function ResultsPanel({
    className = "",
    results,
    logs,
    categories,
    resultViewMode,
    activeCategoryId,
    pendingCount,
    now,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onResultViewModeChange,
    onActiveCategoryChange,
    onCreateCategory,
    onRenameCategory,
    onDeleteCategory,
    onToggleLogCategory,
    onClearLogCategories,
    onDeleteSelected,
    onDeleteLog,
    onPreviewLog,
    onRetryLog,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
    syncingImageIds,
    onSyncResult,
    onSyncLog,
    onRetry,
}: {
    className?: string;
    results: GenerationResult[];
    logs: GenerationLog[];
    categories: GenerationCategory[];
    resultViewMode: ResultViewMode;
    activeCategoryId: string | null;
    pendingCount: number;
    now: number;
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onResultViewModeChange: (mode: ResultViewMode) => void;
    onActiveCategoryChange: (id: string | null) => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onRenameCategory: (category: GenerationCategory, name: string) => void;
    onDeleteCategory: (category: GenerationCategory) => void;
    onToggleLogCategory: (log: GenerationLog, categoryId: string) => void;
    onClearLogCategories: (log: GenerationLog) => void;
    onDeleteSelected: () => void;
    onDeleteLog: (log: GenerationLog) => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    syncingImageIds: string[];
    onSyncResult: (resultId: string, image: GeneratedImage, index: number) => void;
    onSyncLog: (log: GenerationLog, image: GeneratedImage, index: number) => void;
    onRetry: (result: GenerationResult) => void;
}) {
    const { message } = App.useApp();
    const [creatingCategory, setCreatingCategory] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const liveImageIds = new Set(results.map((result) => result.image?.id).filter((id): id is string => Boolean(id)));
    const liveLogIds = new Set(results.flatMap(imageResultIdentityKeys));
    const baseVisibleLogs = logs.filter((log) => !imageLogIdentityKeys(log).some((key) => liveLogIds.has(key)) && !log.images.some((image) => liveImageIds.has(image.id)));
    const categoryGroups = categories.map((category) => ({ category, logs: baseVisibleLogs.filter((log) => log.categoryIds.includes(category.id)) }));
    const activeCategory = activeCategoryId ? categories.find((category) => category.id === activeCategoryId) : null;
    const visibleLogs = resultViewMode === "category" ? (activeCategoryId ? baseVisibleLogs.filter((log) => log.categoryIds.includes(activeCategoryId)) : baseVisibleLogs.filter((log) => !log.categoryIds.length)) : baseVisibleLogs;
    const totalCount = results.length + (resultViewMode === "category" ? (activeCategoryId ? visibleLogs.length : categories.length + visibleLogs.length) : visibleLogs.length);
    const shouldShowGrid = totalCount > 0;
    const completedCount = results.filter((result) => result.status === "success").length + visibleLogs.filter((log) => log.status === "成功").length;
    const failedCount = results.filter((result) => result.status === "failed").length + visibleLogs.filter((log) => log.status === "失败").length;
    const allVisibleLogsSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleVisibleLogs = () => onSelectedLogIdsChange(allVisibleLogsSelected ? selectedLogIds.filter((id) => !visibleLogs.some((log) => log.id === id)) : Array.from(new Set([...selectedLogIds, ...visibleLogs.map((log) => log.id)])));
    const createCategory = async () => {
        const name = categoryName.trim();
        if (!name) {
            message.error("请输入分类名称");
            return;
        }
        const category = await onCreateCategory(name);
        if (!category) return;
        setCategoryName("");
        setCreatingCategory(false);
    };

    useEffect(() => {
        if (activeCategoryId && !categories.some((category) => category.id === activeCategoryId)) onActiveCategoryChange(null);
    }, [activeCategoryId, categories, onActiveCategoryChange]);

    return (
        <div className={`thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5 ${className}`}>
            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <History className="size-4 text-stone-400" />
                    <h2 className="truncate text-xl font-semibold">{activeCategory ? activeCategory.name : "全部结果"}</h2>
                    <Tag className="m-0">{totalCount}</Tag>
                    {completedCount ? <Tag className="m-0" color="success">{completedCount} 个成功</Tag> : null}
                    {pendingCount ? <Tag className="m-0" color="processing">{pendingCount} 个生成中</Tag> : null}
                    {failedCount ? <Tag className="m-0" color="error">{failedCount} 个失败</Tag> : null}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
                    {activeCategory ? (
                        <Button size="small" onClick={() => onActiveCategoryChange(null)}>
                            返回分类
                        </Button>
                    ) : null}
                    <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                        <Button
                            size="small"
                            type={resultViewMode === "all" ? "primary" : "text"}
                            onClick={() => {
                                onActiveCategoryChange(null);
                                onResultViewModeChange("all");
                            }}
                        >
                            全部展示
                        </Button>
                        <Button size="small" type={resultViewMode === "category" ? "primary" : "text"} onClick={() => onResultViewModeChange("category")}>
                            分类展示
                        </Button>
                    </div>
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={resultViewMode === "category" ? () => setCreatingCategory(true) : onCreateSession}>
                        {resultViewMode === "category" ? "新建分类" : "新建"}
                    </Button>
                    <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!visibleLogs.length} onClick={toggleVisibleLogs}>
                        {allVisibleLogsSelected ? "取消" : "全选"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                        删除
                    </Button>
                </div>
            </div>
            {shouldShowGrid ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {results.map((result, index) =>
                        result.status === "success" && result.image ? (
                            <ResultImageCard key={result.id} result={result} image={result.image} index={index} onCopyPrompt={onCopyPrompt} onEdit={onEdit} onDownload={onDownload} onSaveAsset={onSaveAsset} syncing={syncingImageIds.includes(result.image.id)} onSync={(image) => onSyncResult(result.id, image, index)} />
                        ) : result.status === "failed" ? (
                            <FailedImageCard key={result.id} result={result} error={result.error || "生成失败"} onCopyPrompt={onCopyPrompt} onRetry={() => onRetry(result)} />
                        ) : (
                            <PendingImageCard key={result.id} result={result} now={now} onCopyPrompt={onCopyPrompt} />
                        ),
                    )}
                    {resultViewMode === "category" ? (
                        <>
                            {!activeCategoryId
                                ? categoryGroups.map(({ category, logs: categoryLogs }) => (
                                      <CategoryCard key={category.id} category={category} logs={categoryLogs} onRename={onRenameCategory} onDelete={onDeleteCategory} onOpen={() => onActiveCategoryChange(category.id)} />
                                  ))
                                : null}
                        </>
                    ) : null}
                    {visibleLogs.map((log, index) => (
                        <HistoryLogCard
                            key={log.id}
                            log={log}
                            categories={categories}
                            index={index}
                            selected={selectedLogIds.includes(log.id)}
                            active={activeLogId === log.id}
                            onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                            onDelete={() => onDeleteLog(log)}
                            onToggleCategory={(categoryId) => onToggleLogCategory(log, categoryId)}
                            onClearCategories={() => onClearLogCategories(log)}
                            onCreateCategory={onCreateCategory}
                            onPreview={() => onPreviewLog(log)}
                            onRetry={() => onRetryLog(log)}
                            onCopyPrompt={onCopyPrompt}
                            onEdit={onEdit}
                            onDownload={onDownload}
                            onSaveAsset={onSaveAsset}
                            syncing={syncingImageIds.includes(log.images.find((image) => Boolean(image.dataUrl))?.id || "")}
                            onSync={(image) => onSyncLog(log, image, index)}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                    <ImagePlus className="mb-4 size-11 text-stone-400" />
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                </div>
            )}
            <Modal title="新建分类" open={creatingCategory} onCancel={() => setCreatingCategory(false)} onOk={() => void createCategory()} okText="创建" cancelText="取消" destroyOnHidden>
                <Input value={categoryName} autoFocus placeholder="输入分类名称" onChange={(event) => setCategoryName(event.target.value)} onPressEnter={() => void createCategory()} />
            </Modal>
        </div>
    );
}

function CategoryCard({
    category,
    logs,
    onRename,
    onDelete,
    onOpen,
}: {
    category: GenerationCategory;
    logs: GenerationLog[];
    onRename: (category: GenerationCategory, name: string) => void;
    onDelete: (category: GenerationCategory) => void;
    onOpen: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(category.name);
    const images = logs.flatMap((log) => log.images).slice(0, 6);

    useEffect(() => {
        setName(category.name);
    }, [category.name]);

    const saveName = () => {
        const value = name.trim();
        if (!value) return;
        onRename(category, value);
        setEditing(false);
    };

    return (
        <div className="group relative min-h-[360px] overflow-hidden rounded-lg border border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60 sm:min-h-[420px]">
            <button type="button" className="absolute inset-0 z-0 text-left" onClick={onOpen} aria-label={`打开分类 ${category.name}`} />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {images.length ? (
                    <>
                        {images.map((image, index) => (
                            <img
                                key={`${image.id}-${index}`}
                                src={image.dataUrl}
                                alt=""
                                className={`${images.length === 1 ? "inset-0 size-full rounded-none border-0" : "h-[92%] w-[86%] rounded-lg border border-white/80 dark:border-stone-900"} absolute object-cover shadow-xl transition-transform duration-200 group-hover:scale-[1.02]`}
                                style={{
                                    left: images.length === 1 ? 0 : `${3 + index * 4}%`,
                                    top: images.length === 1 ? 0 : `${4 + index * 3}%`,
                                    transform: images.length === 1 ? "none" : `rotate(${(index - 2) * 4}deg)`,
                                    zIndex: index + 1,
                                }}
                            />
                        ))}
                    </>
                ) : (
                    <div className="flex size-full items-center justify-center text-sm text-stone-500">暂无图片</div>
                )}
            </div>
            <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3 pt-10 text-white">
                {editing ? <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onPressEnter={saveName} onBlur={saveName} /> : <div className="truncate text-sm font-semibold">{category.name}</div>}
            </div>
            <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                <Tag className="m-0 text-[10px]">{logs.length} 条</Tag>
                <Tag className="m-0 text-[10px]">{images.length} 图</Tag>
            </div>
            <div className="absolute bottom-2 right-2 z-20 flex gap-1">
                <Button title="改名" size="small" icon={<PenLine className="size-3.5" />} onClick={() => setEditing(true)} />
                <Button title="删除" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(category)} />
            </div>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-3">
            <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                <div className="px-3 py-2">
                    <span className="font-medium text-sm">模型</span>
                </div>
                <div className="border-t border-stone-200 p-3 dark:border-stone-800 space-y-2">
                    <ModelPicker config={config} value={model} capability="image" channelId={config.imageChannelId} onChange={(value, channelId) => { updateConfig("imageModel", value); if (channelId) updateConfig("imageChannelId", channelId); }} fullWidth onMissingConfig={() => openConfigDialog(false)} />
                    <div className="flex items-center justify-between gap-3 pt-1">
                        <div className="text-xs opacity-75">接口模式</div>
                        <Segmented
                            size="small"
                            className="canvas-config-mode !rounded-md !p-0.5"
                            value={config.apiMode}
                            onChange={(value) => updateConfig("apiMode", value as "images" | "responses" | "chat")}
                            options={[
                                { value: "images", label: "images" },
                                { value: "responses", label: "responses" },
                                { value: "chat", label: "chat" },
                            ]}
                        />
                    </div>
                </div>
            </section>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-3" maxCount={10} />
        </div>
    );
}

function ResultImageCard({
    result,
    image,
    index,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
    syncing,
    onSync,
}: {
    result: GenerationResult;
    image: GeneratedImage;
    index: number;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    syncing: boolean;
    onSync: (image: GeneratedImage) => void;
}) {
    return (
        <div className="group overflow-hidden rounded-xl border border-stone-200 bg-background transition duration-200 hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-lg dark:border-stone-800 dark:hover:border-stone-700">
            <div className="relative aspect-[4/3] bg-[radial-gradient(circle_at_center,rgba(120,113,108,0.12),transparent_65%)] dark:bg-[radial-gradient(circle_at_center,rgba(168,162,158,0.10),transparent_65%)]">
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    {!image.storageKey?.startsWith("server:") ? <Tag className="m-0 text-[10px]" color="gold">临时结果</Tag> : null}
                    <Tag className="m-0 text-[10px]" color="success" icon={<CheckCircle2 className="size-3" />}>已完成</Tag>
                </div>
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-[4/3] object-contain" />
            </div>
            <TaskInfo result={result} onCopyPrompt={onCopyPrompt} />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 text-[10px] text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" title="同步到云端存储" icon={<CloudUpload className="size-3.5" />} loading={syncing} disabled={image.storageKey?.startsWith("server:")} onClick={() => onSync(image)} />
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)} />
                    <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)} />
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ result, now, onCopyPrompt }: { result: GenerationResult; now: number; onCopyPrompt: (text: string) => void | Promise<void> }) {
    return (
        <div className="overflow-hidden rounded-xl border border-dashed border-sky-300 bg-sky-50/40 dark:border-sky-900 dark:bg-sky-950/10">
            <div className="relative aspect-[4/3]">
                <div
                    className="absolute inset-0 opacity-60"
                    style={{
                        backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                        backgroundSize: "16px 16px",
                    }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                    <LoaderCircle className="size-6 animate-spin text-sky-500" />
                    <span className="font-medium text-stone-700 dark:text-stone-200">请求处理中</span>
                    <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">{formatDuration(Math.max(0, now - result.createdAt))}</span>
                </div>
            </div>
            <TaskInfo result={{ ...result, durationMs: Math.max(0, now - result.createdAt) }} onCopyPrompt={onCopyPrompt} />
        </div>
    );
}

function FailedImageCard({ result, error, onCopyPrompt, onRetry }: { result: GenerationResult; error: string; onCopyPrompt: (text: string) => void | Promise<void>; onRetry: () => void }) {
    const [detailOpen, setDetailOpen] = useState(false);
    const detail = result.errorDetail || error;
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-3 p-5 text-center">
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <AlertCircle className="size-7 text-red-500" />
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <TaskInfo result={result} error={error} onCopyPrompt={onCopyPrompt} />
            <div className="flex justify-end gap-2 border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" onClick={() => setDetailOpen(true)}>
                    详情
                </Button>
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{detail}</pre>
            </Modal>
        </div>
    );
}

function TaskInfo({ result, error, onCopyPrompt }: { result: GenerationResult; error?: string; onCopyPrompt: (text: string) => void | Promise<void> }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <div className="rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{result.prompt}</div>
                <div className="mt-2 flex justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(result.prompt)}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
                {result.workflowName ? (
                    <Tag className="m-0" color="cyan">
                        工作流 {result.workflowName}
                    </Tag>
                ) : null}
                <Tag className="m-0">{formatLogTime(result.createdAt)}</Tag>
                <Tag className="m-0">{result.model}</Tag>
                <Tag className="m-0">{result.config.apiMode === "chat" ? "Chat" : result.config.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                <Tag className="m-0">{result.config.size || "auto"}</Tag>
                <Tag className="m-0">{result.config.quality || "auto"}</Tag>
                {result.config.apiMode !== "chat" && result.config.streamImages ? <Tag className="m-0">流式 {result.config.streamPartialImages || "1"}</Tag> : null}
                {result.durationMs ? <Tag className="m-0">{formatDuration(result.durationMs)}</Tag> : null}
            </div>
            {error ? <div className="rounded-md bg-red-100 px-2 py-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
    );
}

function HistoryLogCard({
    log,
    categories,
    index,
    selected,
    active,
    onSelectedChange,
    onDelete,
    onToggleCategory,
    onClearCategories,
    onCreateCategory,
    onPreview,
    onRetry,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
    syncing,
    onSync,
}: {
    log: GenerationLog;
    categories: GenerationCategory[];
    index: number;
    selected: boolean;
    active: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onToggleCategory: (categoryId: string) => void;
    onClearCategories: () => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onPreview: () => void;
    onRetry: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    syncing: boolean;
    onSync: (image: GeneratedImage) => void;
}) {
    const displayImages = log.images.filter((image) => Boolean(image.dataUrl));
    const firstImage = displayImages[0];
    const [expanded, setExpanded] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const [detailOpen, setDetailOpen] = useState(false);
    const categoryMenuRef = useRef<HTMLDivElement>(null);
    const logCategories = categories.filter((category) => log.categoryIds.includes(category.id));
    const missingTemporaryImage = log.status === "成功" && log.imageCount > 0 && !firstImage && !log.errors.length;
    const createCategory = async () => {
        const category = await onCreateCategory(categoryName);
        if (!category) return;
        setCategoryName("");
        onToggleCategory(category.id);
        setCategoryOpen(false);
    };
    const closeThen = (action: () => void) => {
        setCategoryOpen(false);
        action();
    };

    useEffect(() => {
        if (!categoryOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!categoryMenuRef.current?.contains(event.target as Node)) setCategoryOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
    }, [categoryOpen]);

    return (
        <div className={`overflow-hidden rounded-xl border bg-background transition duration-200 hover:shadow-md dark:bg-stone-950 ${active ? "border-stone-900 dark:border-stone-100" : "border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700"}`}>
            <div className="relative aspect-[4/3] bg-stone-100 dark:bg-stone-900">
                <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
                    <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                    {selected ? <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /> : null}
                </div>
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    {firstImage && !firstImage.storageKey?.startsWith("server:") ? <Tag className="m-0 text-[10px]" color="gold">临时结果</Tag> : null}
                    {missingTemporaryImage ? <Tag className="m-0 text-[10px]" color="warning">结果未保留</Tag> : null}
                    <Tag className="m-0 text-[10px]" color={log.status === "生成中" ? "processing" : log.failCount ? "red" : "success"}>
                        {log.status === "生成中" ? "生成中" : log.failCount ? `失败 ${log.failCount}` : "成功"}
                    </Tag>
                    <Tag className="m-0 text-[10px]">{log.imageCount} 张</Tag>
                </div>
                {firstImage ? (
                    <Image src={firstImage.dataUrl} alt={`历史结果 ${index + 1}`} className="aspect-[4/3] object-contain" />
                ) : (
                    <div className={`flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm ${missingTemporaryImage ? "text-amber-600 dark:text-amber-300" : "text-red-500"}`}>
                        {missingTemporaryImage ? <CloudUpload className="size-7" /> : <AlertCircle className="size-7" />}
                        <span>{missingTemporaryImage ? "生成成功，临时结果未同步" : log.errors[0] || "没有可显示的图片"}</span>
                        {missingTemporaryImage ? <span className="max-w-52 text-xs leading-5 text-stone-500 dark:text-stone-400">下次生成后请在刷新前同步到云端或保存到素材库</span> : null}
                    </div>
                )}
                {displayImages.length > 1 ? (
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-1 overflow-hidden">
                        {displayImages.slice(0, 4).map((image) => (
                            <img key={image.id} src={image.dataUrl} alt="" className="size-8 shrink-0 rounded border border-white/80 object-cover shadow-sm dark:border-stone-900/80" />
                        ))}
                    </div>
                ) : null}
                <ReferenceThumbnailOverlay references={log.references} className="bottom-1.5 right-1.5" />
            </div>
            <div className="space-y-2 border-t border-stone-200 p-2.5 text-xs dark:border-stone-800">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{log.prompt}</div>
                <div className="flex items-center justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => closeThen(() => void onCopyPrompt(log.prompt))}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => closeThen(() => setExpanded((value) => !value))}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                    {logCategories.length ? (
                        logCategories.map((category) => (
                            <Tag key={category.id} className="m-0 text-[10px]" color="purple">
                                {category.name}
                            </Tag>
                        ))
                    ) : (
                        <Tag className="m-0 text-[10px]">未分类</Tag>
                    )}
                    {log.workflowName ? (
                        <Tag className="m-0 text-[10px]" color="cyan">
                            工作流 {log.workflowName}
                        </Tag>
                    ) : null}
                    <Tag className="m-0 text-[10px]">{formatLogTime(log.createdAt)}</Tag>
                    <Tag className="m-0 text-[10px]">{log.model}</Tag>
                    <Tag className="m-0 text-[10px]">{log.config.apiMode === "chat" ? "Chat" : log.config.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                    <Tag className="m-0 text-[10px]">{log.config.size || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{log.config.quality || "auto"}</Tag>
                    {log.config.apiMode !== "chat" && log.config.streamImages ? <Tag className="m-0 text-[10px]">流式 {log.config.streamPartialImages || "1"}</Tag> : null}
                    <Tag className="m-0 text-[10px]">{formatDuration(log.durationMs)}</Tag>
                </div>
                {log.errors[0] ? (
                    <div className="flex items-start justify-between gap-2 rounded-md bg-red-100 px-2 py-1 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                        <span className="line-clamp-2 min-w-0">{log.errors[0]}</span>
                        <Button size="small" type="text" className="!h-auto !p-0 text-xs" onClick={() => setDetailOpen(true)}>
                            详情
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div ref={categoryMenuRef} className="relative flex flex-wrap gap-1">
                    <Button size="small" onClick={() => closeThen(onPreview)}>
                        载入
                    </Button>
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => closeThen(onRetry)}>
                        重试
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setCategoryOpen((value) => !value)}>
                        分类
                    </Button>
                    {categoryOpen ? (
                        <div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-lg border border-stone-200 bg-background p-2 shadow-xl dark:border-stone-800 dark:bg-stone-950">
                            <div className="max-h-44 space-y-1 overflow-y-auto">
                                {categories.map((category) => (
                                    <label key={category.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-900">
                                        <Checkbox checked={log.categoryIds.includes(category.id)} onChange={() => closeThen(() => onToggleCategory(category.id))} />
                                        <span className="truncate">{category.name}</span>
                                    </label>
                                ))}
                                {!categories.length ? <div className="px-2 py-3 text-center text-xs text-stone-500">暂无分类</div> : null}
                            </div>
                            <div className="mt-2 flex gap-1 border-t border-stone-200 pt-2 dark:border-stone-800">
                                <Input size="small" value={categoryName} placeholder="新分类" onChange={(event) => setCategoryName(event.target.value)} onPressEnter={() => void createCategory()} />
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => void createCategory()} />
                            </div>
                            <Button size="small" type="link" className="!mt-1 !h-auto !p-0 text-xs" onClick={() => closeThen(onClearCategories)}>
                                移至未分类
                            </Button>
                        </div>
                    ) : null}
                </div>
                {firstImage ? (
                    <div className="flex shrink-0 gap-1">
                        <Button size="small" title="同步到云端存储" icon={<CloudUpload className="size-3.5" />} loading={syncing} disabled={firstImage.storageKey?.startsWith("server:")} onClick={() => closeThen(() => onSync(firstImage))} />
                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => closeThen(() => void onSaveAsset(firstImage, index))} />
                        <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => closeThen(() => void onEdit(firstImage, index))} />
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => closeThen(() => onDownload(firstImage, index))} />
                    </div>
                ) : null}
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{log.errorDetails?.[0] || log.errors[0] || "没有详情"}</pre>
            </Modal>
        </div>
    );
}

function ReferenceThumbnailOverlay({ references, className = "" }: { references?: ReferenceImage[]; className?: string }) {
    const visibleReferences = (references || []).filter((item) => Boolean(item.dataUrl)).slice(0, 3);
    if (!visibleReferences.length) return null;
    return (
        <div className={`absolute z-10 flex items-center gap-1 rounded-md bg-black/55 p-1 shadow-sm backdrop-blur ${className}`}>
            {visibleReferences.map((item) => (
                <img key={item.id} src={item.dataUrl} alt={item.name} className="size-7 rounded border border-white/60 object-cover" />
            ))}
            {(references || []).length > visibleReferences.length ? <span className="px-1 text-[10px] text-white">+{(references || []).length - visibleReferences.length}</span> : null}
        </div>
    );
}

function createPendingResult(id: string, snapshot: RequestSnapshot): GenerationResult {
    return {
        id,
        status: "pending",
        createdAt: Date.now(),
        prompt: snapshot.text,
        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
        config: snapshot.displayConfig,
        references: snapshot.references,
    };
}

function generationLogStorageKeys(log: GenerationLog) {
    return [...log.images.map((image) => image.storageKey), ...log.references.filter(isDisposableReferenceFile).map((image) => image.storageKey)].filter((key): key is string => Boolean(key));
}

function referenceUsedByGeneration(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    return logs.some((log) => log.references.some((item) => item.storageKey === reference.storageKey)) || results.some((result) => result.references.some((item) => item.storageKey === reference.storageKey));
}

function shouldDeleteReferenceFile(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    if (!isDisposableReferenceFile(reference)) return false;
    return !referenceUsedByGeneration(reference, logs, results);
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    const item = reference as ReferenceImage & { temporary?: boolean; source?: string };
    return item.temporary === true || item.source === "upload" || item.source === "clipboard";
}

function disposableLogStorageKeys(deletedLogs: GenerationLog[], remainingLogs: GenerationLog[]) {
    const deletedKeys = new Set(deletedLogs.flatMap(generationLogStorageKeys));
    const retainedKeys = new Set(remainingLogs.flatMap(generationLogStorageKeys));
    return [...deletedKeys].filter((key) => !retainedKeys.has(key));
}

function createWorkflowResultId(taskId: string, index: number) {
    return `${taskId}:${index}`;
}

function updateResult(results: GenerationResult[], id: string, next: Partial<GenerationResult>) {
    return results.map((item) => (item.id === id ? { ...item, ...next } : item));
}

function updateResultByLogId(results: GenerationResult[], logId: string, next: Partial<GenerationResult>) {
    const keys = new Set(uniqueStrings([logId, ...imageTaskIdentityKeys(next.task)]));
    return results.map((item) => (imageResultIdentityKeys(item).some((key) => keys.has(key)) ? { ...item, ...next } : item));
}

function mergePendingLogResults(results: GenerationResult[], logs: GenerationLog[]) {
    const updatedResults = results.map((result) => {
        const resultKeys = new Set(imageResultIdentityKeys(result));
        const log = logs.find((item) => imageLogIdentityKeys(item).some((key) => resultKeys.has(key)));
        return log ? { ...result, id: log.id, taskLogId: log.id, task: log.task, progress: log.task?.progress ?? result.progress, durationMs: log.durationMs || result.durationMs, lastPolledAt: log.lastPolledAt || result.lastPolledAt } : result;
    });
    const existingIds = new Set(updatedResults.flatMap(imageResultIdentityKeys));
    const pendingResults = logs.filter((log) => !imageLogIdentityKeys(log).some((key) => existingIds.has(key))).map((log) => createResultFromImageLog(log, "pending"));
    return dedupeGenerationResults([...pendingResults, ...updatedResults]).sort((a, b) => b.createdAt - a.createdAt);
}

function stringRecordValue(record: unknown, key: string) {
    if (!record || typeof record !== "object") return "";
    const value = (record as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: Array<string | undefined>) {
    return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function imageTaskSourceId(task?: CanvasImageTask) {
    return stringRecordValue(task, "source_id") || stringRecordValue(task, "sourceId");
}

function imageTaskIdentityKeys(task?: CanvasImageTask) {
    return uniqueStrings([task?.id, imageTaskSourceId(task), stringRecordValue(task, "task_id"), stringRecordValue(task, "taskId"), stringRecordValue(task, "image_id"), stringRecordValue(task, "imageId"), stringRecordValue(task, "result_id"), stringRecordValue(task, "resultId")]);
}

function imageLogIdentityKeys(log: GenerationLog) {
    const taskKeys = (log.task?.image_urls?.length || 0) > 1
        ? []
        : imageTaskIdentityKeys(log.task);
    return uniqueStrings([
        log.id,
        ...taskKeys,
        ...log.images.flatMap((image) => [image.id, image.storageKey]),
    ]);
}

function imageResultIdentityKeys(result: GenerationResult) {
    return uniqueStrings([result.id, result.taskLogId, ...imageTaskIdentityKeys(result.task), result.image?.id, result.image?.storageKey]);
}

function imageResultMatchesLog(result: GenerationResult, log: GenerationLog) {
    const keys = new Set(imageLogIdentityKeys(log));
    return imageResultIdentityKeys(result).some((key) => keys.has(key));
}

function generationLogRank(log: GenerationLog) {
    return (log.status === "成功" ? 1000 : log.status === "失败" ? 700 : 0) + log.images.length * 100 + log.successCount * 20 + log.failCount * 10 + (log.task ? 5 : 0) + (imageTaskSourceId(log.task) === log.id ? 8 : 0);
}

function preferGenerationLog(next: GenerationLog, current: GenerationLog) {
    const nextSourceId = imageTaskSourceId(next.task);
    const currentSourceId = imageTaskSourceId(current.task);
    if (current.id && nextSourceId === current.id) return false;
    if (next.id && currentSourceId === next.id) return true;
    const nextRank = generationLogRank(next);
    const currentRank = generationLogRank(current);
    if (nextRank !== currentRank) return nextRank > currentRank;
    return next.createdAt >= current.createdAt;
}

function mergeLogIdentityData(primary: GenerationLog, duplicate: GenerationLog) {
    return {
        ...primary,
        task: primary.task || duplicate.task,
        lastPolledAt: primary.lastPolledAt || duplicate.lastPolledAt,
        images: primary.images.length ? primary.images : duplicate.images,
        thumbnails: primary.thumbnails.length ? primary.thumbnails : duplicate.thumbnails,
        successCount: primary.successCount || duplicate.successCount,
        imageCount: primary.imageCount || duplicate.imageCount,
        failCount: primary.failCount || duplicate.failCount,
        errors: primary.errors.length ? primary.errors : duplicate.errors,
        errorDetails: primary.errorDetails?.length ? primary.errorDetails : duplicate.errorDetails,
    };
}

function dedupeGenerationLogs(logs: GenerationLog[]) {
    const merged: GenerationLog[] = [];
    const byKey = new Map<string, number>();
    logs.forEach((log) => {
        const keys = imageLogIdentityKeys(log);
        const index = keys.map((key) => byKey.get(key)).find((value): value is number => value !== undefined);
        if (index === undefined) {
            merged.push(log);
            keys.forEach((key) => byKey.set(key, merged.length - 1));
            return;
        }
        const current = merged[index];
        const primary = preferGenerationLog(log, current) ? log : current;
        const duplicate = primary === log ? current : log;
        const nextLog = mergeLogIdentityData(primary, duplicate);
        merged[index] = nextLog;
        uniqueStrings([...imageLogIdentityKeys(current), ...imageLogIdentityKeys(log), ...imageLogIdentityKeys(nextLog)]).forEach((key) => byKey.set(key, index));
    });
    return merged.sort((a, b) => b.createdAt - a.createdAt);
}

function generationResultRank(result: GenerationResult) {
    return (result.status === "success" ? 1000 : result.status === "failed" ? 700 : 0) + (result.image ? 100 : 0) + (result.task ? 5 : 0) + (imageTaskSourceId(result.task) === result.id ? 8 : 0);
}

function dedupeGenerationResults(results: GenerationResult[]) {
    const merged: GenerationResult[] = [];
    const byKey = new Map<string, number>();
    results.forEach((result) => {
        const keys = imageResultIdentityKeys(result);
        const index = keys.map((key) => byKey.get(key)).find((value): value is number => value !== undefined);
        if (index === undefined) {
            merged.push(result);
            keys.forEach((key) => byKey.set(key, merged.length - 1));
            return;
        }
        const current = merged[index];
        const resultSourceId = imageTaskSourceId(result.task);
        const currentSourceId = imageTaskSourceId(current.task);
        const next = current.id && resultSourceId === current.id ? current : result.id && currentSourceId === result.id ? result : generationResultRank(result) >= generationResultRank(current) ? result : current;
        merged[index] = next;
        uniqueStrings([...imageResultIdentityKeys(current), ...imageResultIdentityKeys(result), ...imageResultIdentityKeys(next)]).forEach((key) => byKey.set(key, index));
    });
    return merged;
}

function createResultFromImageLog(log: GenerationLog, status: GenerationResult["status"]): GenerationResult {
    return {
        id: log.id,
        taskLogId: log.id,
        status,
        createdAt: log.createdAt,
        prompt: log.prompt,
        model: log.model,
        config: log.config,
        references: log.references,
        workflowId: log.workflowId,
        workflowName: log.workflowName,
        workflowInputs: log.workflowInputs,
        workflowTaskId: log.workflowTaskId || log.workflowId,
        task: log.task,
        progress: log.task?.progress,
        lastPolledAt: log.lastPolledAt,
    };
}

function imageLogTaskId(log: GenerationLog) {
    return log.task?.id || "";
}

function isRecoverableImageTask(task: CanvasImageTask) {
    return !isCompletedImageTask(task) && !isFailedImageTask(task);
}

function isCompletedImageTask(task: CanvasImageTask) {
    return Boolean(task.image_url || task.url) || ["completed", "complete", "done", "succeeded", "success"].includes((task.status || "").toLowerCase());
}

function isFailedImageTask(task: CanvasImageTask) {
    return ["failed", "fail", "error", "cancelled", "canceled", "timed_out"].includes((task.status || "").toLowerCase());
}

function mergeBackendImageTasks(logs: GenerationLog[], tasks: CanvasImageTask[], config: AiConfig) {
    const nextLogs = [...logs];
    const byKey = new Map<string, GenerationLog>();
    nextLogs.forEach((log) => imageLogIdentityKeys(log).forEach((key) => byKey.set(key, log)));
    tasks.forEach((task) => {
        const existing = imageTaskIdentityKeys(task).map((key) => byKey.get(key)).find(Boolean);
        if (existing) {
            const index = nextLogs.findIndex((log) => log.id === existing.id);
            if (index >= 0) {
                const nextLog = { ...existing, task, lastPolledAt: existing.lastPolledAt || Date.now() };
                nextLogs[index] = nextLog;
                imageLogIdentityKeys(nextLog).forEach((key) => byKey.set(key, nextLog));
            }
            return;
        }
        const sourceId = imageTaskSourceId(task);
        const startedAt = parseImageTaskTime(task.started_at ?? task.startedAt ?? task.created_at ?? task.createdAt) || Date.now();
        const nextLog = buildLog({
            id: sourceId || task.id,
            prompt: task.prompt || "",
            model: task.model || config.imageModel || config.model,
            config: buildGenerationLogConfig({ ...config, model: task.model || config.imageModel || config.model, count: "1" }),
            references: [],
            durationMs: 0,
            successCount: 0,
            failCount: 0,
            status: "生成中",
            images: [],
            errors: [],
            errorDetails: [],
            categoryIds: [],
            task,
            lastPolledAt: Date.now(),
            createdAt: startedAt,
            time: formatLogTime(startedAt),
        });
        nextLogs.unshift(nextLog);
        imageLogIdentityKeys(nextLog).forEach((key) => byKey.set(key, nextLog));
    });
    return dedupeGenerationLogs(nextLogs);
}

function imageLogsFromTask(log: GenerationLog, task: CanvasImageTask): GenerationLog[] {
    const urls = uniqueStrings(task.image_urls || []);
    if (urls.length <= 1) return [imageLogFromTask(log, task)];
    const parentTaskId = task.parent_task_id || task.id;

    return urls.map((url, index) => {
        const nextLog = imageLogFromTask(
            {
                ...log,
                id: index === 0 ? log.id : `${log.id}:${index}`,
            },
            {
                ...task,
                id: index === 0 ? task.id : `${parentTaskId}:${index}`,
                parent_task_id: parentTaskId,
                url,
                image_url: url,
                storageKey: undefined,
                bytes: 0,
            },
        );

        return {
            ...nextLog,
            images: nextLog.images.map((image) => ({
                ...image,
                id: index === 0 ? task.id : `${parentTaskId}:${index}`,
            })),
        };
    });
}

function imageLogFromTask(log: GenerationLog, task: CanvasImageTask): GenerationLog {
    const startedAt = parseImageTaskTime(task.started_at ?? task.startedAt ?? task.created_at ?? task.createdAt) || log.createdAt;
    const durationMs = Date.now() - startedAt;
    if (isFailedImageTask(task)) {
        const message = task.error?.message || task.error_detail || "图片生成失败";
        return { ...log, task, status: "失败", durationMs, failCount: 1, errors: [message], errorDetails: [task.error_detail || message], lastPolledAt: Date.now() };
    }
    if (isCompletedImageTask(task)) {
        const url = task.image_url || task.url || "";
        if (!url) {
            return { ...log, task, status: "失败", durationMs, failCount: 1, errors: ["图片生成完成但没有返回图片地址"], errorDetails: [JSON.stringify(task, null, 2)], lastPolledAt: Date.now() };
        }
        const image: GeneratedImage = { id: task.id, dataUrl: url, storageKey: task.storageKey, durationMs, width: task.width || 0, height: task.height || 0, bytes: task.bytes || 0, mimeType: task.mimeType || "image/png" };
        return { ...log, task, status: "成功", durationMs, successCount: 1, failCount: 0, imageCount: 1, images: [image], thumbnails: [url], errors: [], errorDetails: [], lastPolledAt: Date.now() };
    }
    return { ...log, task, durationMs, lastPolledAt: Date.now() };
}

function parseImageTaskTime(value: unknown) {
    if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
    if (typeof value !== "string" || !value.trim()) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 100000000000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "生成失败";
}

function errorDetail(error: unknown) {
    if (error instanceof ImageRequestError && error.detail) return error.detail;
    if (error instanceof Error) return error.stack || error.message;
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error || "生成失败");
    }
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return dedupeGenerationLogs(logs);
    } catch {
        return [];
    }
}

async function readStoredCategories() {
    if (typeof window === "undefined") return [];
    try {
        const value = await categoryStore.getItem<GenerationCategory[]>(CATEGORY_STORE_KEY);
        return Array.isArray(value) ? value.filter((item) => item.id && item.name).sort((a, b) => a.createdAt - b.createdAt) : [];
    } catch {
        return [];
    }
}

async function replaceStoredImageHistory(logs: GenerationLog[], categories: GenerationCategory[]) {
    if (typeof window === "undefined") return;
    await logStore.clear();
    await Promise.all(logs.map((log) => logStore.setItem(log.id, serializeLog(log))));
    await categoryStore.setItem(CATEGORY_STORE_KEY, categories);
}

function withWorkflowLogCategories(logs: GenerationLog[], categories: GenerationCategory[]) {
    const byName = new Map(categories.map((category) => [category.name, category]));
    const byId = new Map(categories.map((category) => [category.id, category]));
    let nextCategories = categories;
    let categoriesChanged = false;
    let logsChanged = false;
    const ensureCategory = (name: string, preferredId?: string) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = byName.get(trimmed);
        if (existing) return existing;
        const id = preferredId && !byId.has(preferredId) ? preferredId : nanoid();
        const category = { id, name: trimmed, createdAt: Date.now() };
        if (!categoriesChanged) nextCategories = [...categories];
        categoriesChanged = true;
        nextCategories.push(category);
        byName.set(trimmed, category);
        byId.set(id, category);
        return category;
    };
    const nextLogs = logs.map((log) => {
        const workflowName = log.workflowName?.trim();
        if (!workflowName) return log;
        const missingCategoryId = log.categoryIds.find((id) => !byId.has(id));
        const category = ensureCategory(workflowName, missingCategoryId);
        if (!category || log.categoryIds.includes(category.id)) return log;
        logsChanged = true;
        return { ...log, categoryIds: [...log.categoryIds, category.id] };
    });
    return { logs: logsChanged ? nextLogs : logs, categories: categoriesChanged ? nextCategories : categories };
}

function hasInlineImageData(log: Partial<GenerationLog>) {
    return [...(log.images || []), ...(log.references || [])].some((item) => item.dataUrl?.startsWith("data:image/"));
}

function isClientImageTaskId(value?: string) {
    return typeof value === "string" && value.startsWith("client_image_task_");
}

function isLocalOnlyImageLog(log: GenerationLog) {
    if (isClientImageTaskId(log.task?.id) && !log.task?.source && !log.task?.source_id) return true;
    if (log.config.channelMode === "remote" || log.task) return false;
    return log.status !== "成功" || log.images.length > 0;
}

function shouldSyncImageLog(log: GenerationLog) {
    return !isLocalOnlyImageLog(log);
}

function shouldPreserveLocalImageLogDuringRemoteMerge(log: GenerationLog, remoteKeys: Set<string>) {
    if (!isLocalOnlyImageLog(log) && !(log.status === "生成中" && !log.images.length && !log.task)) return false;
    const keys = imageLogIdentityKeys(log);
    return !keys.length || !keys.some((key) => remoteKeys.has(key));
}

async function mergeGenerationLogs(remoteLogs: GenerationLog[], localLogs: GenerationLog[]) {
    const normalizedRemote = await Promise.all(remoteLogs.map(normalizeLog));
    const normalizedLocal = await Promise.all(localLogs.map(normalizeLog));
    const remoteKeys = new Set(normalizedRemote.flatMap(imageLogIdentityKeys));
    const preservedLocal = normalizedLocal.filter((log) => shouldPreserveLocalImageLogDuringRemoteMerge(log, remoteKeys));
    return dedupeGenerationLogs([...normalizedRemote, ...preservedLocal]);
}

function mergeGenerationCategories(remoteCategories: GenerationCategory[], localCategories: GenerationCategory[]) {
    const byId = new Map<string, GenerationCategory>();
    [...remoteCategories, ...localCategories].forEach((category) => {
        if (category.id && category.name) byId.set(category.id, category);
    });
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            const dataUrl = await resolveImageUrl(item.storageKey, item.dataUrl);
            return { ...item, dataUrl };
        }),
    );
    const visibleImages = images.filter((image) => Boolean(image.dataUrl));
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images: visibleImages,
        thumbnails: visibleImages.map((image) => image.dataUrl),
        errors: log.errors || [],
        errorDetails: log.errorDetails || [],
        categoryIds: Array.isArray(log.categoryIds) ? log.categoryIds : [],
        workflowId: log.workflowId,
        workflowName: log.workflowName,
        workflowInputs: log.workflowInputs,
        workflowTaskId: log.workflowTaskId,
        task: log.task,
        lastPolledAt: log.lastPolledAt,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: persistableImageUrl(item.dataUrl, item.storageKey) })),
        images: log.images.map((image) => ({ ...image, dataUrl: persistableImageUrl(image.dataUrl, image.storageKey) })),
        thumbnails: log.images.map((image) => persistableImageUrl(image.dataUrl, image.storageKey)),
    };
}

function persistableImageUrl(dataUrl?: string, storageKey?: string) {
    if (storageKey) return "";
    if (!dataUrl?.startsWith("data:image/")) return dataUrl || "";
    return "";
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    const taskChannelId = imageTaskChannelId(log.task);
    return {
        channelMode: log.config?.channelMode || "local",
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        activeChannelId: taskChannelId || log.config?.activeChannelId || log.config?.imageChannelId || "",
        imageChannelId: taskChannelId || log.config?.imageChannelId || log.config?.activeChannelId || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
        apiMode: log.config?.apiMode || "images",
        streamImages: typeof log.config?.streamImages === "string" ? log.config.streamImages : log.config?.streamImages ? "1" : "",
        streamPartialImages: typeof log.config?.streamPartialImages === "string" ? log.config.streamPartialImages : "1",
        responseFormatB64Json: typeof log.config?.responseFormatB64Json === "string" ? log.config.responseFormatB64Json : log.config?.responseFormatB64Json === false ? "" : "1",
        codexCli: typeof log.config?.codexCli === "string" ? log.config.codexCli : log.config?.codexCli ? "1" : "",
    };
}

function imageTaskChannelId(task?: CanvasImageTask | null) {
    return task?.userChannelId || task?.channelId || "";
}

function resolveImageChannelId(config: AiConfig, model: string, ...preferredIds: Array<string | undefined>) {
    const channels = modelChannelsForConfig(config).map((channel) => ({ id: channel.id || "", models: channel.models }));
    for (const id of preferredIds) {
        const channelId = (id || "").trim();
        if (channelId && channels.some((channel) => channel.id === channelId && channel.models.includes(model))) return channelId;
    }
    return channels.find((channel) => channel.models.includes(model))?.id || "";
}

function buildGenerationLogConfig(config: AiConfig): GenerationLogConfig {
    return {
        channelMode: config.channelMode,
        model: config.model,
        imageModel: config.imageModel,
        activeChannelId: config.imageChannelId || config.activeChannelId,
        imageChannelId: config.imageChannelId,
        quality: config.quality,
        size: config.size,
        count: config.count,
        apiMode: config.apiMode,
        streamImages: config.streamImages,
        streamPartialImages: config.streamPartialImages,
        responseFormatB64Json: config.responseFormatB64Json,
        codexCli: config.codexCli,
    };
}

function imageExtension(value: string) {
    const lower = value.toLowerCase();
    if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
    if (lower.includes("webp")) return "webp";
    return "png";
}

function defaultWorkflowButtonPosition() {
    if (typeof window === "undefined") return { x: 24, y: 320 };
    return { x: Math.max(16, window.innerWidth - 132), y: Math.max(96, Math.round(window.innerHeight / 2)) };
}

function clampWorkflowButtonPosition(position: { x?: number; y?: number }) {
    if (typeof window === "undefined") return { x: Number(position.x) || 24, y: Number(position.y) || 320 };
    return {
        x: Math.min(Math.max(12, Number(position.x) || 12), Math.max(12, window.innerWidth - 120)),
        y: Math.min(Math.max(72, Number(position.y) || 72), Math.max(72, window.innerHeight - 64)),
    };
}

function buildLog({
    id,
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
    errors,
    errorDetails,
    categoryIds,
    workflowId,
    workflowName,
    workflowInputs,
    task,
    lastPolledAt,
    createdAt,
    time,
}: {
    id?: string;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
    errors: string[];
    errorDetails?: string[];
    categoryIds?: string[];
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    task?: CanvasImageTask;
    lastPolledAt?: number;
    createdAt?: number;
    time?: string;
}): GenerationLog {
    const logConfig = config;
    const logCreatedAt = createdAt || Date.now();
    return {
        id: id || nanoid(),
        createdAt: logCreatedAt,
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: time || formatLogTime(logCreatedAt),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: status === "生成中" ? 0 : Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors,
        errorDetails,
        categoryIds: categoryIds || [],
        workflowId,
        workflowName,
        workflowInputs,
        task,
        lastPolledAt,
    };
}

function formatLogTime(value: number) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}











