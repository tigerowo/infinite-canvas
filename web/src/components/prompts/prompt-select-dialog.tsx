"use client";

import { Check, ChevronDown, ChevronUp, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { App, Button, Empty, Input, Modal, Pagination, Spin } from "antd";
import { usePathname, useRouter } from "next/navigation";

import { ALL_PROMPTS_OPTION } from "@/services/api/prompts";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";
import { useUserStore } from "@/stores/use-user-store";
import { PromptDetailDialog } from "./prompt-detail-dialog";
import { PromptFilterPill } from "./prompt-filter-pill";
import type { Prompt } from "@/services/api/prompts";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const router = useRouter();
    const pathname = usePathname();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [detailPrompt, setDetailPrompt] = useState<Prompt | null>(null);
    const [tagsExpanded, setTagsExpanded] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(12);
    const tagFilterInstanceId = useId();
    const tagFilterId = `prompt-select-tags-${tagFilterInstanceId.replace(/:/g, "")}`;
    const { query, items, tags: promptTags, categories: promptCategories, total } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, page, pageSize, enabled: open });
    const shouldCollapseTags = promptTags.length > 9;
    const visiblePromptTags = tagsExpanded || !shouldCollapseTags
        ? promptTags
        : promptTags.filter((tag, index) => index < 8 || tag === ALL_PROMPTS_OPTION || selectedTags.includes(tag));
    const hiddenPromptTagCount = promptTags.length - visiblePromptTags.length;

    useEffect(() => {
        if (!open || !isReady || user) return;
        onOpenChange(false);
        message.warning("请先登录");
        router.push(`/login?redirect=${encodeURIComponent(pathname + window.location.search)}`);
    }, [isReady, message, onOpenChange, open, pathname, router, user]);
    useEffect(() => {
        setPage(1);
    }, [keyword, selectedCategory, selectedTags]);
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        setDetailPrompt(null);
        onSelect(prompt);
        onOpenChange(false);
    };
    const closeDialog = () => {
        setDetailPrompt(null);
        onOpenChange(false);
    };

    return (
        <Modal title="提示词库" open={open} onCancel={closeDialog} footer={null} width={1040} centered>
            <div data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                <div className="mx-auto max-w-2xl">
                    <Input aria-label="按标题查询提示词" size="large" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按标题查询" />
                </div>
                <div className="mt-5 grid gap-3">
                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                        <div className="flex flex-wrap gap-2">
                            {promptCategories.map((category) => (
                                <PromptFilterPill key={category} active={selectedCategory === category} onClick={() => setSelectedCategory(category)}>
                                    {category}
                                </PromptFilterPill>
                            ))}
                        </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                        <div id={tagFilterId} className="flex flex-wrap gap-2">
                            {visiblePromptTags.map((tag) => {
                                const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                return (
                                    <PromptFilterPill key={tag} active={active} onClick={() => toggleTag(tag)}>
                                        {tag}
                                    </PromptFilterPill>
                                );
                            })}
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
                <div className="thin-scrollbar mt-6 max-h-[520px] overflow-y-auto pr-2" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                    {query.isLoading ? (
                        <div className="flex h-40 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    {!query.isError ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {items.map((item) => (
                            <PromptCard key={item.id} item={item} onOpen={() => setDetailPrompt(item)} onCopy={() => selectPrompt(item.prompt)} actionLabel="使用此提示词" actionIcon={<Check className="size-3.5" />} actionType="primary" />
                        ))}
                    </div> : null}
                    {query.isError ? (
                        <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-rose-300/60 bg-rose-50/70 px-6 py-10 text-center text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-100">
                            <p>提示词加载失败，请检查连接后重试。</p>
                            <Button loading={query.isFetching} onClick={() => void query.refetch()}>重新加载</Button>
                        </div>
                    ) : !query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-8" /> : null}
                    {items.length > 0 ? <div className="mt-6 flex justify-center overflow-x-auto pb-1"><Pagination current={page} pageSize={pageSize} total={total} size="small" showSizeChanger pageSizeOptions={[12, 20, 36]} onChange={(nextPage, nextPageSize) => { setPage(nextPageSize !== pageSize ? 1 : nextPage); setPageSize(nextPageSize); }} /></div> : null}
                </div>
            </div>
            <PromptDetailDialog prompt={detailPrompt} onClose={() => setDetailPrompt(null)} onUse={selectPrompt} />
        </Modal>
    );
}
