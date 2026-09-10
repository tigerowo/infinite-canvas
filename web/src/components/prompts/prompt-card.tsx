"use client";

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { promptPreview } from "@/extensions/glass-ui/prompt-preview";
import styles from "@/extensions/glass-ui/glass-ui.module.css";
import { PromptCoverImage } from "@/components/prompts/prompt-cover-image";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel = "复制",
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
}) {
    return (
        <Card
            hoverable
            className={styles.promptCard}
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className={styles.promptOpen} onClick={onOpen} aria-label={`查看提示词：${item.title}`}>
                    <PromptCoverImage src={item.coverUrl} alt={item.title} className="aspect-[4/3] w-full object-cover" />
                </button>
            }
        >
            <button type="button" className={styles.promptOpen} onClick={onOpen} aria-label={`查看提示词：${item.title}`}>
                <span className="block p-4">
                    <span className="flex items-start justify-between gap-3">
                        <span role="heading" aria-level={2} className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</span>
                        <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{formatPromptDate(item.updatedAt)}</span>
                    </span>
                    <span className={`${styles.promptExcerpt} mt-2 text-xs text-stone-600 dark:text-stone-400`} title="点击查看完整提示词">
                        {promptPreview(item.prompt) || "暂无提示词内容"}
                    </span>
                    <span className="mt-3 flex flex-wrap gap-1.5">
                        {Array.from(new Set(item.tags.filter(Boolean))).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                    </span>
                </span>
            </button>
            <div className="flex items-center gap-2 px-4 pb-4">
                <Button className="min-h-10" block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>
                    {actionLabel}
                </Button>
                {extraAction}
            </div>
        </Card>
    );
}
