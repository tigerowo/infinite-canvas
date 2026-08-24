"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Dropdown, Modal } from "antd";
import { Check, ChevronDown, Lock, LockOpen, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

type DragMode = "move" | "resize";
type ResizeHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const minSize = 0.06;
const defaultCrop = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };

export function CanvasNodeCropDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (crop: CanvasImageCropRect) => Promise<void> | void }) {
    const boxRef = useRef<HTMLDivElement>(null);
    const [crop, setCrop] = useState<CanvasImageCropRect>(defaultCrop);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const cropSize = image ? { width: Math.max(1, Math.round(crop.width * image.width)), height: Math.max(1, Math.round(crop.height * image.height)) } : null;

    useEffect(() => {
        if (open) {
            setCrop(defaultCrop);
            setAspectRatio(null);
        }
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const startDrag = (mode: DragMode, event: ReactPointerEvent, handle?: ResizeHandle) => {
        if (loading) return;
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY, crop };
        const move = (event: PointerEvent) => {
            const dx = (event.clientX - start.x) / box.width;
            const dy = (event.clientY - start.y) / box.height;
            setCrop(mode === "move" ? moveCrop(start.crop, dx, dy) : resizeCrop(start.crop, dx, dy, handle || "se", aspectRatio, box));
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    };

    const applyRatio = (ratio: number | null) => {
        if (ratio === null) {
            setAspectRatio(null);
            return;
        }
        setAspectRatio(ratio);
        const box = boxRef.current?.getBoundingClientRect();
        if (!box || !image) return;

        let w = 0.76;
        let h = (w * box.width) / (ratio * box.height);
        if (h > 0.76) {
            h = 0.76;
            w = (h * ratio * box.height) / box.width;
        }

        const x = (1 - w) / 2;
        const y = (1 - h) / 2;
        setCrop({ x, y, width: w, height: h });
    };

    const handleConfirm = async () => {
        setLoading(true);
        try {
            await onConfirm(crop);
        } finally {
            setLoading(false);
        }
    };

    const ratioMenu = {
        items: [
            { key: "free", label: "自由比例" },
            { key: "original", label: "原始比例" },
            { key: "1:1", label: "1:1 比例" },
            { key: "4:3", label: "4:3 比例" },
            { key: "16:9", label: "16:9 比例" },
            { key: "3:4", label: "3:4 比例" },
            { key: "9:16", label: "9:16 比例" },
        ],
        onClick: ({ key }: { key: string }) => {
            if (key === "free") {
                applyRatio(null);
            } else if (key === "original") {
                if (image) applyRatio(image.width / image.height);
            } else {
                const [w, h] = key.split(":").map(Number);
                applyRatio(w / h);
            }
        },
    };

    const getRatioLabel = () => {
        if (aspectRatio === null) return "自由比例";
        if (image && Math.abs(aspectRatio - image.width / image.height) < 0.01) return "原始比例";
        if (Math.abs(aspectRatio - 1) < 0.01) return "1:1 比例";
        if (Math.abs(aspectRatio - 4 / 3) < 0.01) return "4:3 比例";
        if (Math.abs(aspectRatio - 16 / 9) < 0.01) return "16:9 比例";
        if (Math.abs(aspectRatio - 3 / 4) < 0.01) return "3:4 比例";
        if (Math.abs(aspectRatio - 9 / 16) < 0.01) return "9:16 比例";
        return "比例锁定";
    };

    return (
        <Modal title="裁剪图片" open={open && Boolean(dataUrl)} onCancel={loading ? undefined : onClose} footer={null} width={780} centered destroyOnHidden closable={!loading} mask={{ closable: !loading }}>
            <div className="space-y-4">
                <div className="flex justify-center">
                    <div ref={boxRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-black select-none">
                        <img src={dataUrl} alt="" className="block max-h-[62vh] max-w-full opacity-90" draggable={false} />
                        <CropMask crop={crop} />
                        <div className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.3),0_0_28px_rgba(0,0,0,.28)]" style={cropStyle(crop)} onPointerDown={(event) => startDrag("move", event)}>
                            <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/50" />
                            <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/50" />
                            <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/50" />
                            <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/50" />
                            {handles.map((handle) => (
                                <button key={handle} type="button" className="absolute size-3 rounded-full border border-black bg-white" style={handleStyle(handle)} onPointerDown={(event) => startDrag("resize", event, handle)} aria-label="调整裁剪框" />
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3 text-sm opacity-80">
                        <span>裁剪尺寸 {cropSize ? `${cropSize.width} x ${cropSize.height}` : "未知"}</span>
                        <span>比例 {cropSize ? formatRatio(cropSize.width, cropSize.height) : "未知"}</span>
                        {image ? (
                            <span>
                                原图 {image.width} x {image.height}
                            </span>
                        ) : null}
                    </div>
                    <Dropdown menu={ratioMenu} disabled={loading}>
                        <Button icon={aspectRatio === null ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                            {getRatioLabel()} <ChevronDown className="size-3.5 ml-1 inline-block" />
                        </Button>
                    </Dropdown>
                </div>

                <div className="flex items-center justify-end gap-2">
                    <Button disabled={loading} onClick={() => setCrop(defaultCrop)}>
                        重置
                    </Button>
                    <Button disabled={loading} icon={<X className="size-4" />} onClick={onClose}>
                        取消
                    </Button>
                    <Button type="primary" loading={loading} icon={!loading && <Check className="size-4" />} onClick={handleConfirm}>
                        {loading ? "正在裁剪..." : "确认裁剪"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function CropMask({ crop }: { crop: CanvasImageCropRect }) {
    return (
        <>
            <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: `${crop.y * 100}%` }} />
            <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: `${(1 - crop.y - crop.height) * 100}%` }} />
            <div className="absolute bg-black/55" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
            <div className="absolute bg-black/55" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%`, height: `${crop.height * 100}%` }} />
        </>
    );
}

function moveCrop(crop: CanvasImageCropRect, dx: number, dy: number): CanvasImageCropRect {
    return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}

function resizeCrop(crop: CanvasImageCropRect, dx: number, dy: number, handle: ResizeHandle, aspectRatio: number | null, box: DOMRect): CanvasImageCropRect {
    const next = { ...crop };
    if (handle.includes("e")) next.width = crop.width + dx;
    if (handle.includes("s")) next.height = crop.height + dy;
    if (handle.includes("w")) {
        next.x = crop.x + dx;
        next.width = crop.width - dx;
    }
    if (handle.includes("n")) {
        next.y = crop.y + dy;
        next.height = crop.height - dy;
    }

    if (aspectRatio !== null) {
        if (handle === "n" || handle === "s") {
            next.width = (next.height * box.height * aspectRatio) / box.width;
            next.x = crop.x + (crop.width - next.width) / 2;
        } else if (handle === "e" || handle === "w") {
            next.height = (next.width * box.width) / (aspectRatio * box.height);
            next.y = crop.y + (crop.height - next.height) / 2;
        } else {
            next.height = (next.width * box.width) / (aspectRatio * box.height);
            if (handle.includes("n")) {
                next.y = crop.y + crop.height - next.height;
            }
        }
    }

    next.width = clamp(next.width, minSize, 1);
    next.height = clamp(next.height, minSize, 1);

    if (aspectRatio !== null) {
        if (Math.abs((next.width * box.width) / (next.height * box.height) - aspectRatio) > 0.01) {
            next.height = (next.width * box.width) / (aspectRatio * box.height);
        }
    }

    next.x = clamp(next.x, 0, 1 - next.width);
    next.y = clamp(next.y, 0, 1 - next.height);
    return next;
}

function cropStyle(crop: CanvasImageCropRect) {
    return { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` };
}

function handleStyle(handle: ResizeHandle) {
    const top = handle.includes("n") ? "-6px" : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? "-6px" : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function formatRatio(width: number, height: number) {
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function gcd(a: number, b: number): number {
    return b ? gcd(b, a % b) : Math.max(1, a);
}
