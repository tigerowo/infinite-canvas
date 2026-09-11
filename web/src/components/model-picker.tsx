"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Cpu } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAutoDLWorkflowNames } from "@/hooks/use-autodl-workflow";
import { cn } from "@/lib/utils";
import { selectableModelOptions, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, channelId, capability, onChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const outsideFocus = useRef(false);
    const outsideTarget = useRef<HTMLElement | null>(null);
    const channelOptions = useMemo(() => selectableModelOptions(config, capability), [capability, config]);
    const modelLabel = useAutoDLWorkflowNames(channelOptions);
    const currentOption = useMemo(() => {
        if (!value) return undefined;
        return channelOptions.find((item) => item.model === value && item.channelId === channelId) || channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value]);
    const options = channelOptions;
    const current = currentOption ? value || "" : "";
    const currentValue = current && currentOption ? currentOption.key : "";
    const displayLabel = current || (options.length ? placeholder : "暂无模型");

    useEffect(() => {
        if (value && currentOption?.channelId && channelId !== currentOption.channelId) onChange(value, currentOption.channelId);
    }, [channelId, currentOption?.channelId, onChange, value]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    useEffect(() => {
        if (!open) return;
        outsideFocus.current = false;
        outsideTarget.current = null;
        const dismiss = (event: PointerEvent) => {
            if (event.composedPath().some((node) => node instanceof HTMLElement && node.dataset.modelPicker === pickerId)) return;
            outsideFocus.current = true;
            setOpen(false);
            // Select temporarily disables pointer events outside its modal layer.
            // Locate the intended editor geometrically when the event targets body.
            outsideTarget.current = (event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("input,textarea,[contenteditable='true']") : null)
                || Array.from(document.querySelectorAll<HTMLElement>("input,textarea,[contenteditable='true']")).find((element) => {
                    const box = element.getBoundingClientRect();
                    return box.width > 0 && box.height > 0 && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
                }) || null;
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open, pickerId]);

    return (
        <Select
            open={open}
            value={current ? currentValue : ""}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") {
                    onMissingConfig?.();
                    return;
                }
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={(nextValue) => {
                const option = options.find((item) => item.key === nextValue);
                if (option) onChange(option.model, option.channelId);
            }}
        >
            <SelectTrigger
                data-model-picker={pickerId}
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={displayLabel}
                aria-label={`${({ image: "图片", video: "视频", text: "文本", audio: "音频" } as const)[capability || "text"]}模型`}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{displayLabel}</span>
            </SelectTrigger>
            <SelectContent
                data-model-picker={pickerId}
                onCloseAutoFocus={(event) => {
                    if (!outsideFocus.current) return;
                    event.preventDefault();
                    const target = outsideTarget.current;
                    if (target) requestAnimationFrame(() => target.isConnected && target.focus());
                }}
                data-canvas-no-zoom
                className="canvas-model-picker-content z-[1200] w-[min(15rem,calc(100vw-24px))] max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onEscapeKeyDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
            >
                {options.length ? (
                    options.map((option) => (
                        <SelectItem key={option.key} value={option.key} textValue={`${modelLabel(option.model, option)} ${option.model} ${option.channelName}`}>
                            <ModelLabel model={option.model} label={modelLabel(option.model, option)} channelName={option.channelName} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        暂无模型
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function ModelLabel({ model, label, channelName }: { model: string; label?: string; channelName?: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate" title={model}>{label || model}</span>
            {channelName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{channelName}</span> : null}
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
