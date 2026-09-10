"use client";

import { Copy, FolderPlus } from "lucide-react";
import { Button, Modal, Space, Tag } from "antd";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import styles from "@/extensions/glass-ui/glass-ui.module.css";
import { PromptCoverImage } from "@/components/prompts/prompt-cover-image";

export function PromptDetailDialog({ prompt, onClose, onCopy, onUse, onSaveAsset }: { prompt: Prompt | null; onClose: () => void; onCopy?: (prompt: string) => void; onUse?: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void }) {
    const preview = prompt?.preview.replace(/!\[[^\]]*]\([^)]+\)/g, "").trim() || "";
    return (
        <>
            <Modal className={styles.promptModal} title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={860} destroyOnHidden>
                {prompt ? (
                    <>
                        <div className="grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
                            <div className="space-y-3">
                                <PromptCoverImage src={prompt.coverUrl} alt={prompt.title} className="aspect-[4/3] w-full rounded-lg object-cover" />
                                {preview ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{preview}</pre> : null}
                            </div>
                            <div className={`${styles.promptBody} min-w-0`}>
                                <div className="flex flex-wrap gap-1.5">
                                    {Array.from(new Set(prompt.tags.filter(Boolean))).map((tag) => (
                                        <Tag key={tag} className="m-0">
                                            {tag}
                                        </Tag>
                                    ))}
                                </div>
                                <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-800 dark:text-stone-300">{prompt.prompt}</p>
                                <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">
                                    创建：{formatPromptDate(prompt.createdAt)} · 更新：{formatPromptDate(prompt.updatedAt)}
                                </div>
                                <Space wrap className="mt-5">
                                    {onUse ? (
                                        <Button type="primary" onClick={() => onUse(prompt.prompt)}>
                                            使用此提示词
                                        </Button>
                                    ) : null}
                                    {onCopy ? (
                                        <Button icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                            复制提示词
                                        </Button>
                                    ) : null}
                                    {onSaveAsset ? (
                                        <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>
                                            加入我的素材
                                        </Button>
                                    ) : null}
                                </Space>
                            </div>
                        </div>
                    </>
                ) : null}
            </Modal>
        </>
    );
}
