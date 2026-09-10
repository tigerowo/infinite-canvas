"use client";

import { ArrowRight } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Tag } from "antd";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { promptPreview } from "@/extensions/glass-ui/prompt-preview";
import { PromptDetailDialog } from "@/components/prompts/prompt-detail-dialog";
import { PromptCoverImage } from "@/components/prompts/prompt-cover-image";
import { useCopyText } from "@/hooks/use-copy-text";
import glassStyles from "@/extensions/glass-ui/glass-ui.module.css";
import { cn } from "@/lib/utils";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { AssetPickerModal } from "./canvas/components/asset-picker-modal";
import { CanvasAssistantComposer } from "./canvas/components/canvas-assistant-composer";
import { useCanvasStore } from "./canvas/stores/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { canvasResourceLabel } from "./canvas/utils/canvas-resource-references";
import { HomeBannerCarousel, type HomeBanner } from "./home-banner-carousel";
import { filterHomeBanners } from "@/extensions/home-banners/config";
import {
    MAX_CANVAS_AGENT_SKILLS,
    CanvasNodeType,
    type CanvasAgentConfig,
    type CanvasAgentSkillSelection,
    type CanvasAssistantReference,
    type InsertAssetPayload,
    type PendingAgentAsset,
} from "./canvas/types";


const HOME_BANNERS: HomeBanner[] = filterHomeBanners([
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.7/img/infinite-canvas/88.webp", videoUrl: "", linkUrl: "https://88api.ai/sign-up?aff=25ty", alt: "1" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.6/img/infinite-canvas/metaso.webp", videoUrl: "", linkUrl: "https://metaso.cn/minimax-h3/?s=tt", alt: "2" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.5/img/infinite-canvas/3ddirectortl.webp", videoUrl: "", linkUrl: "", alt: "3" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/agent.webp", videoUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/agent.webm", linkUrl: "", alt: "4" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/panorama.webp", videoUrl: "", linkUrl: "", alt: "5" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/3ddirector.webp", videoUrl: "", linkUrl: "", alt: "6" },
]);

// 首页暂时隐藏宣传卡片；需要恢复时改为 true 即可。
const SHOW_HOME_BANNERS = false;

function toPendingAgentAsset(payload: InsertAssetPayload, label: string): PendingAgentAsset {
    const nodeId = nanoid();
    let reference: CanvasAssistantReference;
    if (payload.kind === "text") {
        reference = { id: nodeId, type: CanvasNodeType.Text, title: payload.title, label, text: payload.content };
    } else {
        const common = { id: nodeId, title: payload.title, label, storageKey: payload.storageKey, mimeType: payload.mimeType };
        if (payload.kind === "image") reference = { ...common, type: CanvasNodeType.Image, dataUrl: payload.dataUrl };
        else if (payload.kind === "video") reference = { ...common, type: CanvasNodeType.Video, url: payload.url };
        else reference = { ...common, type: CanvasNodeType.Audio, url: payload.url };
    }
    return { nodeId, payload, reference };
}

export default function IndexPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isUserReady = useUserStore((state) => state.isReady);
    const effectiveConfig = useEffectiveConfig();
    const createProject = useCanvasStore((state) => state.createProject);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [promptShowcase, setPromptShowcase] = useState<Prompt[]>([]);
    const [promptShowcaseLoading, setPromptShowcaseLoading] = useState(false);
    const [promptShowcaseError, setPromptShowcaseError] = useState(false);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [prompt, setPrompt] = useState("");
    const [pendingAssets, setPendingAssets] = useState<PendingAgentAsset[]>([]);
    const [selectedSkills, setSelectedSkills] = useState<CanvasAgentSkillSelection[]>([]);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const copyText = useCopyText();
    const [agentConfig, setAgentConfig] = useState<CanvasAgentConfig>(() => ({
        textApiMode: "responses",
        autoGenerateMedia: false,
        imageQuality: effectiveConfig.quality,
        imageSize: effectiveConfig.size,
        videoQuality: effectiveConfig.vquality,
        videoSize: effectiveConfig.videoSize,
    }));
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const pendingAssetCountsRef = useRef<Record<InsertAssetPayload["kind"], number>>({ text: 0, image: 0, video: 0, audio: 0 });

    const refreshPromptShowcase = useCallback(async () => {
        if (!isUserReady || !user) {
            setPromptShowcase([]);
            setPromptShowcaseLoading(false);
            return;
        }
        setPromptShowcaseLoading(true);
        setPromptShowcaseError(false);
        try {
            const data = await fetchPrompts({ pageSize: 12 });
            setPromptShowcase(data.items);
        } catch (error) {
            setPromptShowcaseError(true);
            message.error(error instanceof Error ? error.message : "获取提示词失败");
        } finally {
            setPromptShowcaseLoading(false);
        }
    }, [isUserReady, message, user]);

    useEffect(() => {
        void refreshPromptShowcase();
    }, [refreshPromptShowcase]);

    const addPendingAsset = (payload: InsertAssetPayload) => {
        const asset = toPendingAgentAsset(payload, canvasResourceLabel(payload.kind, pendingAssetCountsRef.current[payload.kind]++));
        setPendingAssets((current) => [...current, asset]);
        setPrompt((current) => `${current}${current.endsWith(" ") ? "" : " "}${asset.reference.label} `);
    };

    const uploadFile = async (file: File) => {
        try {
            if (file.type.startsWith("image/")) {
                const uploaded = await uploadImage(file);
                addPendingAsset({ kind: "image", dataUrl: uploaded.url, title: file.name, ...uploaded });
            } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
                const uploaded = await uploadAssetMediaFile(file);
                if (file.type.startsWith("video/")) addPendingAsset({ kind: "video", title: file.name, ...uploaded });
                else addPendingAsset({ kind: "audio", title: file.name, ...uploaded });
            } else {
                throw new Error("仅支持图片、视频和音频文件");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材上传失败");
        }
    };

    const onUploadInputChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void uploadFile(file);
    };

    const submit = (nextPrompt = prompt, referenceIds = pendingAssets.map((asset) => asset.nodeId)) => {
        if (!isUserReady) {
            message.info("登录状态正在检查，请稍后再试");
            return;
        }
        if (!user) {
            message.warning("请先登录");
            router.push(`/login?redirect=${encodeURIComponent("/")}`);
            return;
        }
        const text = nextPrompt.trim();
        if (!text || submitting) return;
        if (!hydrated) {
            message.info("画布数据正在加载，请稍后再试");
            return;
        }
        setSubmitting(true);
        const titles = new Set(useCanvasStore.getState().projects.map(({ title }) => title));
        let title = "微鑫画布";
        for (let i = 1; titles.has(title); i++) title = `微鑫画布 ${i}`;
        const projectId = createProject(title, {
            agentConfig,
            pendingAgentRequest: { prompt: text, assets: pendingAssets.filter((asset) => referenceIds.includes(asset.nodeId)), skills: selectedSkills },
        });
        router.push(`/canvas/${projectId}`);
    };

    const selectSkill = (skill: CanvasAgentSkillSelection) => {
        const existingIndex = selectedSkills.findIndex((selected) => selected.id === skill.id && selected.source === skill.source);
        if (existingIndex >= 0) return setSelectedSkills(selectedSkills.map((selected, index) => index === existingIndex ? skill : selected));
        if (selectedSkills.length >= MAX_CANVAS_AGENT_SKILLS) return void message.warning(`最多选择 ${MAX_CANVAS_AGENT_SKILLS} 个 Skill`);
        setSelectedSkills([...selectedSkills, skill]);
    };

    return (
        <main className="relative h-full overflow-x-hidden overflow-y-auto bg-background text-stone-950 before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_18%_8%,rgba(56,189,248,.12),transparent_30%),radial-gradient(circle_at_82%_24%,rgba(167,139,250,.10),transparent_28%)] before:content-[''] dark:text-stone-100">
            <section className="relative mx-auto min-h-[calc(100vh-4rem)] max-w-7xl px-6">
                <section className={`${glassStyles.homeHero} relative flex min-h-[620px] flex-col items-center justify-center py-10 sm:py-14`}>
                    {SHOW_HOME_BANNERS ? <HomeBannerCarousel banners={HOME_BANNERS} /> : null}
                    <div className="mt-12 w-full max-w-[820px]">
                        <CanvasAssistantComposer
                            prompt={prompt}
                            isRunning={false}
                            references={pendingAssets.map((asset) => asset.reference)}
                            selectedSkills={selectedSkills}
                            agentConfig={agentConfig}
                            onAgentConfigChange={(patch) => setAgentConfig((current) => ({ ...current, ...patch }))}
                            onPromptChange={setPrompt}
                            onReferenceIdsChange={(ids) => setPendingAssets((current) => current.filter((asset) => ids.includes(asset.nodeId)))}
                            onSkillSelect={selectSkill}
                            onSkillRemove={(id, source) => setSelectedSkills((current) => current.filter((skill) => skill.id !== id || skill.source !== source))}
                            onSubmit={submit}
                            onOpenUpload={() => uploadInputRef.current?.click()}
                            onOpenAssets={() => setAssetPickerOpen(true)}
                            onPasteImage={(file) => void uploadFile(file)}
                        />
                    </div>
                    <input ref={uploadInputRef} hidden type="file" accept="image/*,video/*,audio/*" onChange={onUploadInputChange} />
                </section>

                {isUserReady && user ? <section className="relative mx-auto mb-20 max-w-6xl border-t border-stone-200/60 pt-12 dark:border-stone-800/60">
                    <div className="mb-8 grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
                        <div />
                        <div className="max-w-2xl text-center">
                            <div className="flex flex-wrap items-center justify-center gap-3">
                                <h2 className="text-3xl font-semibold text-stone-950 dark:text-stone-100">沉淀每一次好结果</h2>
                                <Button type="primary" size="middle" href="https://prompts.tdeh.top/" target="_blank" rel="noreferrer" className="-translate-y-[6px]">提示词仓库</Button>
                            </div>
                            <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">收藏稳定出图的提示词、参考风格和结果图片，让下一次创作从已有经验开始。</p>
                        </div>
                        <Button type="link" href="/prompts" className="justify-self-center md:justify-self-end" icon={<ArrowRight className="size-4" />} iconPlacement="end">
                            提示词库
                        </Button>
                    </div>
                    {promptShowcaseLoading ? (
                        <div className="grid auto-rows-[210px] gap-4 md:grid-cols-4" aria-label="正在加载提示词">
                            {Array.from({ length: 4 }, (_, index) => <div key={index} className="animate-pulse motion-reduce:animate-none rounded-3xl border border-stone-200/60 bg-stone-200/40 dark:border-stone-800/60 dark:bg-stone-900/50" />)}
                        </div>
                    ) : promptShowcaseError ? (
                        <div role="status" className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-amber-300/60 bg-amber-50/70 px-6 py-12 text-center text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">
                            <span>提示词暂时加载失败，你可以重试。</span>
                            <Button onClick={() => void refreshPromptShowcase()}>重新加载</Button>
                        </div>
                    ) : promptShowcase.length ? <div className="grid auto-rows-[210px] gap-4 md:grid-cols-4">
                        {promptShowcase.map((item, index) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => setSelectedPrompt(item)}
                                className={cn(
                                    glassStyles.showcaseCard,
                                    "group relative cursor-pointer overflow-hidden text-left",
                                    index === 0 && "md:col-span-2 md:row-span-2",
                                    index === 3 && "md:col-span-2",
                                )}
                            >
                                <PromptCoverImage
                                    src={item.coverUrl}
                                    alt={item.title}
                                    className="h-full w-full object-cover"
                                    imageClassName="transition duration-500 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:transform-none"
                                />
                                <div className={`${glassStyles.showcaseOverlay} absolute inset-x-0 bottom-0 p-4 text-white`}>
                                    <div className="mb-2 flex flex-wrap gap-1.5">
                                        {Array.from(new Set(item.tags.filter(Boolean))).slice(0, 2).map((tag) => (
                                            <Tag key={tag} variant="filled" className="m-0 bg-white/15 text-[11px] text-white backdrop-blur">
                                                {tag}
                                            </Tag>
                                        ))}
                                    </div>
                                    <h3 className="text-sm font-medium">{item.title}</h3>
                                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/75" title="点击查看完整提示词">{promptPreview(item.prompt)}</p>
                                </div>
                            </button>
                        ))}
                    </div> : (
                        <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-stone-300/80 px-6 py-12 text-center dark:border-stone-700">
                            <p className="text-sm text-stone-500 dark:text-stone-400">还没有可展示的提示词</p>
                            <Button href="/prompts">打开提示词库</Button>
                        </div>
                    )}
                </section> : null}
            </section>
            <AssetPickerModal
                open={assetPickerOpen}
                defaultTab="my-assets"
                onInsert={(payload) => {
                    addPendingAsset(payload);
                    setAssetPickerOpen(false);
                }}
                onClose={() => setAssetPickerOpen(false)}
            />
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(value) => copyText(value, "提示词已复制")} />
        </main>
    );
}
