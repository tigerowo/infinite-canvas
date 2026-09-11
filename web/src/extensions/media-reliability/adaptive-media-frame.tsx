"use client";
import { useState, type ReactNode, type SyntheticEvent } from "react";

// Real decoded dimensions take priority over model settings and saved metadata.
export function AdaptiveMediaFrame({ children, className = "", width, height, fallback = 16 / 9 }: { children: ReactNode; className?: string; width?: number; height?: number; fallback?: number }) {
    const [ratio, setRatio] = useState<number>();
    const measure = (event: SyntheticEvent) => {
        const media = event.target as HTMLImageElement & HTMLVideoElement;
        if (!media.closest("[data-adaptive-media]")) return;
        const w = media.videoWidth || media.naturalWidth;
        const h = media.videoHeight || media.naturalHeight;
        if (w > 0 && h > 0) setRatio(w / h);
    };
    return <div className={`relative ${className}`} style={{ aspectRatio: ratio || (width && height ? width / height : fallback) }} onLoadCapture={measure} onLoadedMetadataCapture={measure}>{children}</div>;
}
