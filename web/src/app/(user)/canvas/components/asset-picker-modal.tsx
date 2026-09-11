"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Empty, Input, Modal, Pagination, Spin, Tabs, Tag } from "antd";
import { ImagePlus, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { fetchAssetLibrary, type AssetLibraryItem } from "@/services/api/assets";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { libraryAssetDragPayload, userAssetDragPayload, writeAssetDrag } from "@/extensions/media-reliability/asset-dnd";
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
        <Modal title="选择素材" open={open} onCancel={onClose} footer={null} width="min(860px, calc(100vw - 24px))" destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: "min(480px, calc(100dvh - 190px))", maxHeight: "calc(100dvh - 190px)", overflowY: "auto" } }}>
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

function LibraryTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("");
    const [page, setPage] = useState(1);
    const [inserting, setInserting] = useState<string | null>(null);

    const query = useQuery({
        queryKey: ["asset-picker-library", keyword, kindFilter, page],
        queryFn: () => fetchAssetLibrary({ keyword, type: kindFilter, page, pageSize: PAGE_SIZE }),
        retry: false,
    });

    const items = query.data?.items || [];
    const total = query.data?.total || 0;

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
                    className="w-full sm:w-56"
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
                <div className="flex flex-wrap gap-1.5">
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

            {query.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : items.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {items.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            title={asset.title}
                            kind={asset.type}
                            cover={asset.coverUrl}
                            dragPayload={libraryAssetDragPayload(asset)}
                            loading={inserting === asset.id}
                            onClick={() => void handleInsert(asset)}
                        />
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

function PickerCard({ title, kind, cover, dragPayload, loading, onClick }: { title: string; kind: string; cover: string; dragPayload?: InsertAssetPayload; loading?: boolean; onClick: () => void }) {
    const normalizedCover = cover.trim();
    const [coverFailed, setCoverFailed] = useState(false);

    useEffect(() => {
        setCoverFailed(false);
    }, [normalizedCover]);

    return (
        <button
            type="button"
            draggable={Boolean(dragPayload)}
            onDragStart={(event) => { if (dragPayload) writeAssetDrag(event, dragPayload); }}
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
            disabled={loading}
        >
            {normalizedCover && !coverFailed ? (
                <img src={normalizedCover} alt={title} className="aspect-[4/3] w-full object-cover" onError={() => setCoverFailed(true)} />
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
    const [page, setPage] = useState(1);
    const [createOpen, setCreateOpen] = useState(false);
    const [createKind, setCreateKind] = useState<"text" | "image" | "video" | "audio">("image");
    const [createTitle, setCreateTitle] = useState("");
    const [createText, setCreateText] = useState("");
    const [createUrl, setCreateUrl] = useState("");
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

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
                    className="w-full sm:w-56"
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
                <div className="flex flex-wrap gap-1.5">
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

            {visible.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {visible.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            title={asset.title}
                            kind={asset.kind}
                            cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")}
                            dragPayload={userAssetDragPayload(asset)}
                            onClick={() => handleInsert(asset)}
                        />
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
                            <Button icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                {selectedFile ? selectedFile.name : createKind === "image" ? "选择图片" : createKind === "video" ? "选择视频" : "选择音频"}
                            </Button>
                            <Input value={createUrl} placeholder={createKind === "image" ? "图片 URL" : createKind === "video" ? "视频 URL" : "音频 URL"} onChange={(event) => setCreateUrl(event.target.value)} />
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
}
