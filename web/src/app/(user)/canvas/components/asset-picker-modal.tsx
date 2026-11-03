"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Empty, Input, Modal, Pagination, Spin, Tabs, Tag } from "antd";
import { ImagePlus, Plus, Search, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { fetchAssetLibrary, type AssetLibraryItem } from "@/services/api/assets";
import { uploadAnonymousTemporaryFile } from "@/services/anonymous-storage";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import type { InsertAssetPayload } from "../types";

export type { InsertAssetPayload } from "../types";

export type AssetPickerTab = "my-assets" | "library";

type Props = {
    open: boolean;
    defaultTab?: AssetPickerTab;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, defaultTab = "my-assets", onInsert, onClose }: Props) {
    const [activeTab, setActiveTab] = useState<AssetPickerTab>(defaultTab);

    useEffect(() => {
        if (open) setActiveTab(defaultTab);
    }, [open, defaultTab]);

    return (
        <Modal title="选择素材" open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as AssetPickerTab)}
                items={[
                    { key: "my-assets", label: "我的素材", children: <MyAssetsTab onInsert={onInsert} /> },
                    { key: "library", label: "素材库", children: <LibraryTab onInsert={onInsert} /> },
                ]}
            />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

function AssetFilters({ categories, tags, category, selectedTags, onCategoryChange, onTagsChange }: { categories: string[]; tags: string[]; category: string; selectedTags: string[]; onCategoryChange: (value: string) => void; onTagsChange: (values: string[]) => void }) {
    return (
        <div className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">分类</div>
                <div className="thin-scrollbar flex max-h-[112px] flex-wrap gap-2 overflow-y-auto pr-1">
                    {["", ...categories].map((value) => (
                        <Tag.CheckableTag key={value || "all"} checked={category === value} className={cn("prompt-filter-tag", category === value && "is-active")} onChange={() => onCategoryChange(value)}>
                            {value || "全部"}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">标签</div>
                <div className="thin-scrollbar flex max-h-[112px] flex-wrap gap-2 overflow-y-auto pr-1">
                    <Tag.CheckableTag checked={selectedTags.length === 0} className={cn("prompt-filter-tag", selectedTags.length === 0 && "is-active")} onChange={() => onTagsChange([])}>
                        全部
                    </Tag.CheckableTag>
                    {tags.map((tag) => (
                        <Tag.CheckableTag
                            key={tag}
                            checked={selectedTags.includes(tag)}
                            className={cn("prompt-filter-tag", selectedTags.includes(tag) && "is-active")}
                            onChange={() => onTagsChange(selectedTags.includes(tag) ? selectedTags.filter((value) => value !== tag) : [...selectedTags, tag])}
                        >
                            {tag}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>
        </div>
    );
}

function LibraryTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("");
    const [category, setCategory] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [page, setPage] = useState(1);
    const [inserting, setInserting] = useState<string | null>(null);

    const query = useQuery({
        queryKey: ["asset-picker-library", keyword, kindFilter, category, selectedTags, page],
        queryFn: () => fetchAssetLibrary({ keyword, type: kindFilter, category, tag: selectedTags, page, pageSize: PAGE_SIZE }),
        retry: false,
    });

    const items = query.data?.items || [];
    const total = query.data?.total || 0;
    const categories = query.data?.categories || [];
    const tags = query.data?.tags || [];

    const handleInsert = async (asset: AssetLibraryItem) => {
        try {
            setInserting(asset.id);
            if (asset.type === "text") {
                onInsert({ kind: "text", content: asset.content, title: asset.title, source: "library" });
            } else if (asset.type === "video") {
                onInsert({ kind: "video", url: asset.url, title: asset.title, source: "library" });
            } else if (asset.type === "audio") {
                onInsert({ kind: "audio", url: asset.url, title: asset.title, source: "library" });
            } else {
                onInsert({ kind: "image", dataUrl: asset.url, title: asset.title, source: "library" });
            }
        } catch {
            message.error("插入失败");
        } finally {
            setInserting(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索素材"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex min-h-6 items-center gap-1.5">
                    {[
                        { label: "全部", value: "" },
                        { label: "文本", value: "text" },
                        { label: "图片", value: "image" },
                        { label: "视频", value: "video" },
                        { label: "音频", value: "audio" },
                    ].map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value || "all"}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>
            <AssetFilters categories={categories} tags={tags} category={category} selectedTags={selectedTags} onCategoryChange={(value) => { setPage(1); setCategory(value); }} onTagsChange={(values) => { setPage(1); setSelectedTags(values); }} />

            {query.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : items.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {items.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.type} cover={asset.coverUrl} loading={inserting === asset.id} onClick={() => void handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {total > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

function PickerCard({ title, kind, cover, loading, onClick }: { title: string; kind: string; cover: string; loading?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
            disabled={loading}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "文本"}</Tag>
                </div>
            </div>
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-stone-900/60">
                    <Spin size="small" />
                </div>
            )}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">插入</div>
        </button>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [category, setCategory] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [page, setPage] = useState(1);
    const [createOpen, setCreateOpen] = useState(false);
    const [createKind, setCreateKind] = useState<"text" | "image" | "video" | "audio">("image");
    const [createTitle, setCreateTitle] = useState("");
    const [createText, setCreateText] = useState("");
    const [createUrl, setCreateUrl] = useState("");
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const anonymousInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const categories = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.category ? [asset.category] : []))), [assets]);
    const tags = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags || []))), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !category || a.category === category)
            .filter((a) => !selectedTags.length || selectedTags.some((tag) => (a.tags || []).includes(tag)))
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, category, selectedTags]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id, source: "asset" });
        } else {
            onInsert(
                asset.kind === "video"
                    ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" }
                    : asset.kind === "audio"
                      ? { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, bytes: asset.data.bytes, mimeType: asset.data.mimeType, durationMs: asset.data.durationMs, source: "asset" }
                      : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, assetId: asset.id, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, source: "asset" },
            );
        }
    };

    const resetCreateForm = () => {
        setCreateTitle("");
        setCreateText("");
        setCreateUrl("");
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const createAsset = async () => {
        const title = createTitle.trim();
        if (!title) {
            message.error("请输入素材名称");
            return;
        }
        setSaving(true);
        try {
            if (createKind === "text") {
                const content = createText.trim();
                if (!content) {
                    message.error("请输入文本内容");
                    return;
                }
                addAsset({ kind: "text", title, coverUrl: "", tags: [], source: "素材选择器", data: { content } });
            } else if (createKind === "image") {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择图片或填写图片 URL");
                    return;
                }
                const stored = selectedFile ? await uploadImage(selectedFile) : null;
                addAsset({
                    kind: "image",
                    title,
                    coverUrl: stored?.url || createUrl.trim(),
                    tags: [],
                    source: "素材选择器",
                    data: stored ? { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } : { dataUrl: createUrl.trim(), width: 0, height: 0, bytes: 0, mimeType: "image/*" },
                });
            } else if (createKind === "video") {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择视频或填写视频 URL");
                    return;
                }
                const stored = selectedFile ? await uploadAssetMediaFile(selectedFile, "asset-video") : null;
                addAsset({
                    kind: "video",
                    title,
                    coverUrl: "",
                    tags: [],
                    source: "素材选择器",
                    data: stored
                        ? { url: stored.url, storageKey: stored.storageKey, width: stored.width || 0, height: stored.height || 0, bytes: stored.bytes, mimeType: stored.mimeType }
                        : { url: createUrl.trim(), width: 0, height: 0, bytes: 0, mimeType: "video/mp4" },
                });
            } else {
                if (!selectedFile && !createUrl.trim()) {
                    message.error("请选择音频或填写音频 URL");
                    return;
                }
                const stored = selectedFile ? await uploadAssetMediaFile(selectedFile, "asset-audio") : null;
                addAsset({
                    kind: "audio",
                    title,
                    coverUrl: "",
                    tags: [],
                    source: "素材选择器",
                    data: stored ? { url: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType, durationMs: stored.durationMs } : { url: createUrl.trim(), mimeType: "audio/mpeg" },
                });
            }
            message.success("素材已新增");
            setCreateOpen(false);
            resetCreateForm();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "新增素材失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索素材"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
                    新增素材
                </Button>
            </div>
            <AssetFilters categories={categories} tags={tags} category={category} selectedTags={selectedTags} onCategoryChange={(value) => { setPage(1); setCategory(value); }} onTagsChange={(values) => { setPage(1); setSelectedTags(values); }} />

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
            <Modal
                title="新增素材"
                open={createOpen}
                onCancel={() => {
                    setCreateOpen(false);
                    resetCreateForm();
                }}
                onOk={() => void createAsset()}
                okText="保存"
                confirmLoading={saving}
                destroyOnHidden
            >
                <div className="space-y-3 pt-2">
                    <div className="flex gap-2">
                        {[
                            { value: "image" as const, label: "图片" },
                            { value: "text" as const, label: "文本" },
                            { value: "video" as const, label: "视频" },
                            { value: "audio" as const, label: "音频" },
                        ].map((item) => (
                            <Tag.CheckableTag key={item.value} checked={createKind === item.value} className={cn("prompt-filter-tag", createKind === item.value && "is-active")} onChange={() => setCreateKind(item.value)}>
                                {item.label}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <Input value={createTitle} placeholder="素材名称" onChange={(event) => setCreateTitle(event.target.value)} />
                    {createKind === "text" ? (
                        <Input.TextArea value={createText} autoSize={{ minRows: 5, maxRows: 10 }} placeholder="文本内容" onChange={(event) => setCreateText(event.target.value)} />
                    ) : (
                        <div className="space-y-2">
                            <input ref={fileInputRef} type="file" accept={createKind === "image" ? "image/*" : createKind === "video" ? "video/*" : "audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"} className="hidden" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
                            <input ref={anonymousInputRef} type="file" accept={`${createKind}/*`} className="hidden" onChange={async (event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                if (!file) return;
                                setSaving(true);
                                try {
                                    setCreateUrl(await uploadAnonymousTemporaryFile(file));
                                    message.success("匿名上传成功，文件将在 7 天后自动删除");
                                    setSelectedFile(null);
                                    if (fileInputRef.current) fileInputRef.current.value = "";
                                } catch (error) {
                                    message.error((error as Error).message);
                                } finally {
                                    setSaving(false);
                                }
                            }} />
                            <Input value={createUrl} placeholder={createKind === "image" ? "图片 URL" : createKind === "video" ? "视频 URL" : "音频 URL"} onChange={(event) => setCreateUrl(event.target.value)} />
                            <div className="grid grid-cols-2">
                                <Button className="!h-8 !min-w-0 !w-full !overflow-hidden !rounded-r-none" icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                    <span className="min-w-0 truncate">
                                        {selectedFile ? selectedFile.name : createKind === "image" ? "选择图片" : createKind === "video" ? "选择视频" : "选择音频"}
                                    </span>
                                </Button>
                                <Button className="!h-8 !w-full !rounded-l-none !border-l-0 !whitespace-nowrap" loading={saving} icon={<Upload className="size-4" />} onClick={() => anonymousInputRef.current?.click()}>
                                    匿名公网上传
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
}
