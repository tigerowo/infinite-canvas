"use client";

import { ChevronDown, ChevronUp, FolderPlus, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { App, Button, Empty, Input, Pagination, Spin } from "antd";

import { PromptCard } from "@/components/prompts/prompt-card";
import { PromptDetailDialog } from "@/components/prompts/prompt-detail-dialog";
import { PromptFilterPill } from "@/components/prompts/prompt-filter-pill";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";
import glassStyles from "@/extensions/glass-ui/glass-ui.module.css";

export default function PromptsPage() {
    const { message } = App.useApp();
    const [titleInput, setTitleInput] = useState("");
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [tagsExpanded, setTagsExpanded] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const tagFilterInstanceId = useId();
    const tagFilterId = `prompt-tags-${tagFilterInstanceId.replace(/:/g, "")}`;
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory, page, pageSize });
    const shouldCollapseTags = promptTags.length > 9;
    const visiblePromptTags = tagsExpanded || !shouldCollapseTags
        ? promptTags
        : promptTags.filter((tag, index) => index < 8 || tag === ALL_PROMPTS_OPTION || selectedTags.includes(tag));
    const hiddenPromptTagCount = promptTags.length - visiblePromptTags.length;

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success("已加入我的素材");
    };

    const searchByTitleInput = () => {
        setTitleKeyword(titleInput);
    };

    useEffect(() => {
        setPage(1);
    }, [titleKeyword, selectedCategory, selectedTags]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main
                className="relative min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_12%_6%,rgba(56,189,248,.10),transparent_28%),radial-gradient(circle_at_88%_18%,rgba(167,139,250,.10),transparent_26%)] before:content-[''] sm:px-6 sm:py-8"
            >
                <div className="relative pb-8">
                    <div className={`${glassStyles.promptHeader} mx-auto max-w-6xl text-center`}>
                        <h1 className="text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-100 sm:text-4xl">提示词中心</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">共 {totalPrompts} 条提示词，按标题、标签与分类快速查找灵感。</p>
                    </div>
                    {query.isLoading ? (
                        <div className="flex h-60 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    {!query.isLoading ? (
                        <>
                            <div className={`${glassStyles.promptFilters} mx-auto mt-6 w-full max-w-6xl`}>
                                <div className="mx-auto w-full max-w-2xl">
                                    <Input aria-label="按标题查询提示词" size="large" className="w-full" prefix={<Search className="size-4 text-stone-400" />} value={titleInput} placeholder="按标题查询，按 Enter 搜索" onChange={(event) => setTitleInput(event.target.value)} onPressEnter={searchByTitleInput} />
                                </div>
                                <div className="mt-5 grid gap-3 text-left">
                                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                                        <div className="flex flex-wrap gap-2">
                                            {promptCategoryOptions.map((category) => (
                                                <PromptFilterPill key={category} active={selectedCategory === category} onClick={() => setSelectedCategory(category)}>
                                                    {category}
                                                </PromptFilterPill>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                                        <div id={tagFilterId} className="flex flex-wrap gap-2">
                                            {visiblePromptTags.map((tag) => (
                                                <PromptFilterPill
                                                    key={tag}
                                                    active={tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag)}
                                                    onClick={() => toggleTag(tag)}
                                                >
                                                    {tag}
                                                </PromptFilterPill>
                                            ))}
                                            {shouldCollapseTags ? (
                                                <PromptFilterPill
                                                    action
                                                    expanded={tagsExpanded}
                                                    ariaControls={tagFilterId}
                                                    onClick={() => setTagsExpanded((expanded) => !expanded)}
                                                >
                                                    {tagsExpanded ? <ChevronUp aria-hidden="true" className="size-3.5" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
                                                    {tagsExpanded ? "收起标签" : `展开全部标签${hiddenPromptTagCount > 0 ? `（${hiddenPromptTagCount}）` : ""}`}
                                                </PromptFilterPill>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>

                {!query.isLoading ? (
                    <div>
                        <div className="mx-auto grid max-w-7xl gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {!query.isError ? promptItems.map((item) => (
                                <PromptCard
                                    key={item.id}
                                    item={item}
                                    onOpen={() => setSelectedPrompt(item)}
                                    onCopy={() => copyText(item.prompt, "提示词已复制")}
                                    extraAction={
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>
                                            加入我的素材
                                        </Button>
                                    }
                                />
                            )) : null}
                        </div>
                        {query.isError ? (
                            <div role="alert" className="mx-auto flex max-w-xl flex-col items-center justify-center gap-3 rounded-3xl border border-rose-300/60 bg-rose-50/70 px-6 py-12 text-center text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-100">
                                <p>提示词加载失败，请检查连接后重试。</p>
                                <Button loading={query.isFetching} onClick={() => void query.refetch()}>重新加载</Button>
                            </div>
                        ) : promptItems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-16" /> : null}
                        {promptItems.length > 0 ? (
                            <div className="mt-8 flex justify-center overflow-x-auto pb-2">
                                <Pagination
                                    current={page}
                                    pageSize={pageSize}
                                    total={totalPrompts}
                                    showSizeChanger
                                    pageSizeOptions={[12, 20, 36, 60]}
                                    responsive
                                    showTotal={(total, range) => `${range[0]}-${range[1]} / 共 ${total} 条`}
                                    onChange={(nextPage, nextPageSize) => {
                                        setPage(nextPageSize !== pageSize ? 1 : nextPage);
                                        setPageSize(nextPageSize);
                                    }}
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, "提示词已复制")} onSaveAsset={savePromptAsset} />
        </div>
    );
}
