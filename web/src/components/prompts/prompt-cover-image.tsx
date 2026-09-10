"use client";

import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export function PromptCoverImage({
    src,
    alt,
    className,
    imageClassName,
    fallbackClassName,
}: {
    src?: string;
    alt: string;
    className?: string;
    imageClassName?: string;
    fallbackClassName?: string;
}) {
    const normalizedSrc = src?.trim() || "";
    const [failed, setFailed] = useState(() => !normalizedSrc);

    useEffect(() => {
        setFailed(!normalizedSrc);
    }, [normalizedSrc]);

    if (failed || !normalizedSrc) {
        return (
            <div
                role="img"
                aria-label={`${alt}封面暂时无法读取`}
                className={cn(
                    "flex items-center justify-center bg-stone-100 text-stone-500 dark:bg-stone-900 dark:text-stone-400",
                    className,
                    fallbackClassName,
                )}
            >
                <span className="flex flex-col items-center gap-2 px-4 text-center text-xs leading-5">
                    <ImageOff aria-hidden="true" className="size-5 opacity-60" />
                    <span>封面暂时无法读取</span>
                </span>
            </div>
        );
    }

    return (
        <img
            src={normalizedSrc}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className={cn(className, imageClassName)}
        />
    );
}
