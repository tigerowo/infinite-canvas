"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App, Button } from "antd";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { filterModelsByCapability, normalizeLocalChannels, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

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
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const user = useUserStore((state) => state.user);
    const isGuestConfigDisabled = !user && publicSettings?.modelChannel?.allowGuestConfig === false;
    const channelOptions = useMemo(() => {
        const channels =
            config.channelMode === "remote"
                ? config.publicChannels.map((channel) => ({ id: channel.id, name: channel.name || "云端渠道", baseUrl: channel.baseUrl, models: channel.models }))
                : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, name: channel.name || "本地渠道", baseUrl: channel.baseUrl, models: channel.models }));
        const infos = config.modelInfos || [];
        const models = channels.flatMap((channel) => (channel.models ?? []).map((model) => ({ key: `${channel.id}::${model}`, channelId: channel.id, channelName: channel.name, model, description: infos.find((item) => item.model === model)?.description || "" })));
        if (!capability) return models;
        return models.filter((item) => filterModelsByCapability([item.model], capability).length > 0);
    }, [capability, config]);
    const currentOption = useMemo(() => {
        if (!value) return undefined;
        return channelOptions.find((item) => item.model === value && item.channelId === channelId) || channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value]);
    const options = channelOptions;
    // 当 value 不在任一渠道的模型列表中时（currentOption 为空），显示 placeholder 而非具体模型名
    const current = value && currentOption ? value : "";

    useEffect(() => {
        if (value && currentOption?.channelId && channelId !== currentOption.channelId) onChange(value, currentOption.channelId);
    }, [channelId, currentOption?.channelId, onChange, value]);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const handleOpen = () => {
        if (!options.length && config.channelMode === "local") {
            // 未登录且后台关闭 allowGuestConfig 时，直接提示，不触发配置弹窗
            if (isGuestConfigDisabled) {
                message.info("请登录后使用配置功能");
                return;
            }
            onMissingConfig?.();
            return;
        }
        setOpen((current) => !current);
    };

    const handleSelect = (model: string, channelId?: string) => {
        onChange(model, channelId);
        setOpen(false);
    };

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0 shrink-0">
                <Button
                    size="small"
                    type="text"
                    className={cn(
                        "!h-8 !min-w-0 !justify-start !rounded-md !px-1.5 !text-[10.8px] !whitespace-nowrap",
                        fullWidth ? "!w-full" : "",
                        className,
                    )}
                    style={{ background: "transparent", color: theme.node.text, fontFamily: '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' }}
                    icon={<ModelIcon model={current} />}
                    onClick={handleOpen}
                    title={current || placeholder}
                >
                    <span className="flex min-w-0 items-center gap-1">
                        <span className="whitespace-nowrap">{current || placeholder}</span>
                        <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                    </span>
                </Button>
            </span>
            {open && buttonRect ? createPortal(
                <ModelPickerPortal
                    buttonRect={buttonRect}
                    panelRef={panelRef}
                    theme={theme}
                    options={options}
                    currentModel={current}
                    onSelect={handleSelect}
                    emptyText={config.channelMode === "remote" ? "暂无可用模型" : "请先到配置里拉取模型列表"}
                />,
                document.body,
            ) : null}
        </>
    );
}

function ModelPickerPortal({ buttonRect, panelRef, theme, options, currentModel, onSelect, emptyText }: {
    buttonRect: DOMRect;
    panelRef: React.RefObject<HTMLDivElement | null>;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    options: { key: string; channelId: string; channelName?: string; model: string; description?: string }[];
    currentModel: string;
    onSelect: (model: string, channelId?: string) => void;
    emptyText: string;
}) {
    const width = 320;
    const gap = 8;
    const margin = 12;
    const left = buttonRect.left + buttonRect.width / 2 - width / 2;
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        top: buttonRect.bottom + gap,
        maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2),
        background: theme.toolbar.panel,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 18,
        boxShadow: "none",
        padding: 8,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-model-picker-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {options.length ? (
                <div className="flex flex-col gap-0.5">
                    {options.map((option) => {
                        const active = option.model === currentModel;
                        return (
                            <button
                                key={option.key}
                                type="button"
                                className="group/item flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none transition"
                                style={{ color: theme.node.text, fontFamily: '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' }}
                                onMouseEnter={(event) => { event.currentTarget.style.background = theme.node.subtleFill; }}
                                onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                                onClick={(event) => { event.stopPropagation(); onSelect(option.model, option.channelId); }}
                            >
                                <ModelLabel model={option.model} subtitle={option.description} />
                                {active ? <Check className="size-3 shrink-0 opacity-70" /> : null}
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="px-2 py-3 text-center text-xs opacity-55">{emptyText}</div>
            )}
        </div>,
        document.body,
    );
}

function ModelLabel({ model, subtitle = "" }: { model: string; subtitle?: string }) {
    return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            <ModelIcon model={model} size="size-[30px]" />
            <span className="flex h-[34px] min-w-0 flex-1 flex-col overflow-hidden">
                <span className="flex flex-col translate-y-[8px] transition-transform duration-200 ease-out group-hover/item:translate-y-0">
                    <span className="truncate text-[16px] font-medium leading-[18px]">{model}</span>
                    <span className="truncate text-[12px] leading-[14px] opacity-0 transition-opacity duration-200 ease-out group-hover/item:opacity-55">{subtitle}</span>
                </span>
            </span>
        </span>
    );
}

function ModelIcon({ model, size = "size-3" }: { model: string; size?: string }) {
    const icon = resolveModelIcon(model);
    return <img src={icon} alt="" className={`${size} shrink-0 dark:invert`} />;
}

export function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("imagen") || name.includes("veo")) return "/icons/gemini.svg";
    if (name.includes("nano") && name.includes("banana")) return "/icons/nano-banana.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/gpt.svg";
    if (name.includes("sora")) return "/icons/sora.svg";
    if (name.includes("grok") || name.includes("xai")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("zhipu") || name.includes("chatglm")) return "/icons/glm.svg";
    if (name.includes("qwen") || name.includes("tongyi") || name.includes("wanxiang")) return "/icons/qwen.svg";
    if (name.includes("hunyuan")) return "/icons/hunyuan.svg";
    if (name.includes("kimi") || name.includes("moonshot")) return "/icons/kimi.svg";
    if (name.includes("kling") || name.includes("keling")) return "/icons/keling.svg";
    if (name.includes("mimo") || name.includes("miaomi")) return "/icons/xiaomi.svg";
    if (name.includes("minimax")) return "/icons/minimax.svg";
    if (name.includes("hailuo")) return "/icons/hailuo.svg";
    if (name.includes("flux")) return "/icons/flux.svg";
    if (name.includes("midjourney") || name.includes("mj")) return "/icons/midjourney.svg";
    if (name.includes("pixverse")) return "/icons/pixverse.svg";
    if (name.includes("seedream") || name.includes("doubao") || name.includes("seedance")) return "/icons/seedream.svg";
    return "/icons/auto.svg";
}
