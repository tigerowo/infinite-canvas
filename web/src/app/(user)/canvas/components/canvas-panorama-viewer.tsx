"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Maximize2, Move } from "lucide-react";
import { SYSTEM, Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

import { canvasThemes } from "@/lib/canvas-theme";
import { getProxyUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasPanoramaViewerProps = {
    src: string;
    alt: string;
    proxyGeneratedPanorama?: boolean;
    expandOnDoubleClick?: boolean;
    immersive?: boolean;
    onMoveStart?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onOpen?: () => void;
};

type PanoramaSurfaceProps = {
    src: string;
    alt: string;
    proxyGeneratedPanorama: boolean;
    viewerEntry: PanoramaViewerEntry;
};

const MAX_ACTIVE_PANORAMA_VIEWERS = 4;

type PanoramaViewerEntry = {
    setActive: (active: boolean) => void;
};

const activePanoramaViewers: PanoramaViewerEntry[] = [];

function registerPanoramaViewer(entry: PanoramaViewerEntry) {
    if (activePanoramaViewers.includes(entry)) return true;
    if (activePanoramaViewers.length >= MAX_ACTIVE_PANORAMA_VIEWERS) {
        entry.setActive(false);
        return false;
    }

    activePanoramaViewers.push(entry);
    entry.setActive(true);
    return true;
}

function activatePanoramaViewer(entry: PanoramaViewerEntry) {
    const index = activePanoramaViewers.indexOf(entry);
    if (index >= 0) activePanoramaViewers.splice(index, 1);

    activePanoramaViewers.push(entry);
    entry.setActive(true);

    if (activePanoramaViewers.length > MAX_ACTIVE_PANORAMA_VIEWERS) {
        activePanoramaViewers.shift()?.setActive(false);
    }
}

function releasePanoramaViewer(entry: PanoramaViewerEntry) {
    const index = activePanoramaViewers.indexOf(entry);
    if (index >= 0) activePanoramaViewers.splice(index, 1);
}

function PanoramaSurface({ src, alt, proxyGeneratedPanorama, viewerEntry }: PanoramaSurfaceProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const panoramaSrc = proxyGeneratedPanorama ? getProxyUrl(src) : src;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        if (!registerPanoramaViewer(viewerEntry)) return;
        setStatus("loading");
        let viewer: Viewer | null = null;
        let cancelled = false;

        function handleReady() {
            setStatus("ready");
        }

        function handleError() {
            setStatus("error");
            destroyAndReleaseViewer();
        }

        function destroyViewer() {
            const currentViewer = viewer;
            if (!currentViewer) return;
            viewer = null;
            currentViewer.removeEventListener("ready", handleReady);
            currentViewer.removeEventListener("panorama-error", handleError);
            const contextLoss = currentViewer.container.querySelector<HTMLCanvasElement>(".psv-canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context");
            try {
                currentViewer.destroy();
            } finally {
                contextLoss?.loseContext();
            }
        }

        function destroyAndReleaseViewer() {
            try {
                destroyViewer();
            } finally {
                releasePanoramaViewer(viewerEntry);
            }
        }

        // 大图(超 2048px)先降采样到安全尺寸再喂给 viewer,规避大纹理上传挂起。
        async function preparePanoramaSource() {
            const img = new Image();
            img.crossOrigin = "anonymous";
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("全景图加载失败"));
                img.src = panoramaSrc;
            });
            if (cancelled) return panoramaSrc;
            if (img.width <= 2048) return panoramaSrc;
            const ratio = 2048 / img.width;
            const scaled = document.createElement("canvas");
            scaled.width = Math.floor(img.width * ratio);
            scaled.height = Math.floor(img.height * ratio);
            const ctx = scaled.getContext("2d");
            if (!ctx) return panoramaSrc;
            ctx.drawImage(img, 0, 0, scaled.width, scaled.height);
            const blob = await new Promise<Blob | null>((resolve) => scaled.toBlob(resolve, "image/jpeg", 0.92));
            return blob ? URL.createObjectURL(blob) : panoramaSrc;
        }

        try {
            SYSTEM.load();
            void preparePanoramaSource().then((safeSrc) => {
                if (cancelled) return;
                viewer = new Viewer({
                    container,
                    panorama: safeSrc,
                    navbar: false,
                    mousewheel: true,
                    mousemove: true,
                    touchmoveTwoFingers: false,
                    moveInertia: false,
                    defaultZoomLvl: 50,
                    minFov: 25,
                    maxFov: 110,
                });
                viewer.addEventListener("ready", handleReady);
                viewer.addEventListener("panorama-error", handleError);
            }).catch(() => {
                if (!cancelled) setStatus("error");
            });
        } catch {
            destroyAndReleaseViewer();
            container.replaceChildren();
            setStatus("error");
            return;
        }

        return () => {
            cancelled = true;
            destroyViewer();
        };
    }, [panoramaSrc, viewerEntry]);

    return (
        <div className="relative h-full w-full overflow-hidden">
            {status === "error" ? (
                <img src={src} alt={alt} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" />
            ) : null}
            <div ref={containerRef} className="absolute inset-0 transition-opacity duration-200" style={{ opacity: status === "ready" ? 1 : 0 }} />
            {status === "loading" ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 text-xs text-white/80">正在加载全景图...</div> : null}
            {status === "error" ? <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-white/80">全景图加载失败</div> : null}
        </div>
    );
}

export default function CanvasPanoramaViewer({ src, alt, proxyGeneratedPanorama = false, expandOnDoubleClick = false, immersive = false, onMoveStart, onOpen }: CanvasPanoramaViewerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const controlStyle = { background: theme.toolbar.panel, color: theme.toolbar.item };
    const [active, setActive] = useState<boolean | null>(null);
    const [surfaceKey, setSurfaceKey] = useState(0);
    const viewerEntryRef = useRef<PanoramaViewerEntry>({ setActive });

    useEffect(() => {
        const entry = viewerEntryRef.current;
        if (immersive) activatePanoramaViewer(entry);
        else registerPanoramaViewer(entry);
        return () => releasePanoramaViewer(entry);
    }, [immersive]);

    const activate = () => {
        const entry = viewerEntryRef.current;
        const shouldRetry = active === true && !activePanoramaViewers.includes(entry);
        activatePanoramaViewer(entry);
        if (shouldRetry) setSurfaceKey((current) => current + 1);
    };
    const surface =
        active === null ? null : active ? (
            <PanoramaSurface key={surfaceKey} src={src} alt={alt} proxyGeneratedPanorama={proxyGeneratedPanorama} viewerEntry={viewerEntryRef.current} />
        ) : (
            <img src={src} alt={alt} draggable={false} className="pointer-events-none h-full w-full select-none object-contain" />
        );

    if (immersive)
        return (
            <div
                className="h-full w-full overflow-hidden"
                data-canvas-no-zoom
                tabIndex={-1}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerEnter={activate}
                onPointerDown={(event) => {
                    activate();
                    event.stopPropagation();
                }}
                onWheel={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
            >
                {surface}
            </div>
        );

    return (
        <div
            className="relative h-full w-full overflow-hidden"
            data-canvas-no-zoom
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerEnter={activate}
            onPointerDown={(event) => {
                activate();
                event.stopPropagation();
            }}
            onWheel={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!expandOnDoubleClick || !onOpen) return;
                event.stopPropagation();
                onOpen();
            }}
        >
            {surface}
            {onMoveStart ? (
                <button
                    type="button"
                    title="拖动节点"
                    aria-label="拖动节点"
                    className="absolute left-2 top-2 z-20 flex size-7 cursor-grab items-center justify-center rounded-md opacity-70 backdrop-blur transition-opacity hover:opacity-100 active:cursor-grabbing"
                    style={controlStyle}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        onMoveStart(event);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                >
                    <Move className="size-3.5" />
                </button>
            ) : null}
            {onOpen ? (
                <button
                    type="button"
                    title="沉浸式查看"
                    aria-label="沉浸式查看"
                    className="absolute bottom-2 left-2 z-20 flex size-7 items-center justify-center rounded-md opacity-70 backdrop-blur transition-opacity hover:opacity-100"
                    style={controlStyle}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpen();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                >
                    <Maximize2 className="size-3.5" />
                </button>
            ) : null}
        </div>
    );
}
