"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { jimengModelProfile } from "@/lib/jimeng-models";
import { cn } from "@/lib/utils";
import { filterModelsByCapability, modelChannelsForConfig, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

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

const CLI_PROTOCOLS = new Set(["codex", "codex-image-emergency", "gpt-image-2", "gemini-cli", "gemini-official-cli", "jimeng", "chatgpt-subscription-proxy", "antigravity-subscription-proxy"]);
const RECENT_MODELS_STORAGE_KEY = "infinite-canvas:recent-models";
const RECENT_MODELS_EVENT = "model-picker-recent-change";
const MAX_RECENT_MODELS = 12;

export function ModelPicker({ config, value, channelId, capability, onChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [recentModelKeys, setRecentModelKeys] = useState<string[]>([]);
    const channelOptions = useMemo(() => {
        const channels = modelChannelsForConfig(config);
        const models = channels.flatMap((channel) =>
            channel.models.map((model) => ({
                key: `${channel.id}::${model}`,
                channelId: channel.id,
                channelName: channel.name || ("managed" in channel && channel.managed ? "连接中心" : config.channelMode === "remote" ? "云端渠道" : "本地渠道"),
                protocol: channel.protocol,
                model,
                capabilities: "capabilities" in channel ? channel.capabilities : undefined,
                recommended: "defaultModel" in channel && channel.defaultModel === model,
                connectionStatus: "connectionStatus" in channel ? channel.connectionStatus : undefined,
                statusMessage: "statusMessage" in channel ? channel.statusMessage : "",
            })),
        );
        if (!capability) return models;
        return models.filter((item) => (item.capabilities?.length === 1 ? item.capabilities[0] === capability : filterModelsByCapability([item.model], capability, item.protocol || "").length > 0));
    }, [capability, config]);
    const currentOption = useMemo(() => {
        if (!value) return undefined;
        const exact = channelOptions.find((item) => item.model === value && item.channelId === channelId);
        return channelId ? exact : channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value]);
    const recentModelRanks = useMemo(() => new Map(recentModelKeys.map((key, index) => [key, index])), [recentModelKeys]);
    const options = useMemo(() => [...channelOptions].sort((a, b) => {
        const aUnavailable = isUnavailableStatus(a.connectionStatus);
        const bUnavailable = isUnavailableStatus(b.connectionStatus);
        return Number(b.key === currentOption?.key) - Number(a.key === currentOption?.key)
            || Number(aUnavailable) - Number(bUnavailable)
            || (recentModelRanks.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (recentModelRanks.get(b.key) ?? Number.MAX_SAFE_INTEGER)
            || modelStatusRank(a.connectionStatus) - modelStatusRank(b.connectionStatus)
            || Number(b.recommended) - Number(a.recommended);
    }), [channelOptions, currentOption?.key, recentModelRanks]);
    const current = value || "";
    const currentValue = current && currentOption ? currentOption.key : "";

    useEffect(() => {
        if (value && !channelId && currentOption?.channelId) onChange(value, currentOption.channelId);
    }, [channelId, currentOption?.channelId, onChange, value]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    useEffect(() => {
        setRecentModelKeys(readRecentModelKeys());
        const syncRecentModels = (event: Event) => setRecentModelKeys((event as CustomEvent<string[]>).detail || readRecentModelKeys());
        window.addEventListener(RECENT_MODELS_EVENT, syncRecentModels);
        return () => window.removeEventListener(RECENT_MODELS_EVENT, syncRecentModels);
    }, []);

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
                if (option) {
                    rememberRecentModel(option.key);
                    onChange(option.model, option.channelId);
                }
            }}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-1.5 overflow-hidden rounded-full border px-2.5 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    currentOption ? "border-ring/70 bg-accent/80 hover:bg-accent" : "border-input bg-transparent hover:bg-accent/50",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={currentOption ? `${modelDisplayName(current, currentOption.protocol)} · ${current}\n${currentOption.channelName}` : current || placeholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 basis-0 truncate text-left">{current ? modelDisplayName(current, currentOption?.protocol) : placeholder}</span>
                {currentOption?.channelName ? <span className="min-w-0 max-w-[42%] truncate rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground ring-1 ring-border/70">{currentOption.channelName}</span> : null}
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    <SelectGroup>
                        <SelectLabel className="px-2 pb-1.5 pt-1 text-[11px]">CLI 仅显示真实调用成功的模型；API 状态来自连接中心检测</SelectLabel>
                        {options.map((option) => (
                            <SelectItem
                                key={option.key}
                                value={option.key}
                                textValue={`${modelDisplayName(option.model, option.protocol)} ${option.model} ${option.channelName}`}
                                disabled={isUnavailableStatus(option.connectionStatus)}
                                className="my-0.5 min-h-14 px-2 py-2 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground data-[state=checked]:ring-1 data-[state=checked]:ring-ring/60"
                            >
                                <ModelLabel
                                    model={option.model}
                                    protocol={option.protocol}
                                    channelName={option.channelName}
                                    selected={option.key === currentValue}
                                    recent={recentModelRanks.has(option.key)}
                                    recommended={option.recommended}
                                    connectionStatus={option.connectionStatus}
                                    statusMessage={option.statusMessage}
                                />
                            </SelectItem>
                        ))}
                    </SelectGroup>
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {config.channelMode === "remote" ? "暂无可用模型" : "请先到配置里拉取模型列表"}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

type ModelConnectionStatus = "untested" | "connected" | "failed" | "timeout" | "disabled" | "unavailable";

function ModelLabel({ model, protocol, channelName, selected = false, recent = false, recommended = false, connectionStatus, statusMessage }: { model: string; protocol?: string; channelName?: string; selected?: boolean; recent?: boolean; recommended?: boolean; connectionStatus?: ModelConnectionStatus; statusMessage?: string }) {
    const status = modelStatus(protocol, connectionStatus);
    return (
        <span className="flex min-w-0 flex-1 items-start gap-2">
            <ModelIcon model={model} />
            <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("min-w-0 flex-1 truncate", selected && "font-semibold")}>{modelDisplayName(model, protocol)}</span>
                    {selected ? <ModelBadge label="已选" tone="selected" /> : null}
                    {!selected && recent ? <ModelBadge label="最近" tone="neutral" /> : null}
                    {recommended ? <ModelBadge label="推荐" tone="selected" /> : null}
                    <ModelBadge label={status.label} tone={status.tone} title={statusMessage} />
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate font-mono" title={model}>{model}</span>
                    {channelName ? <span className="max-w-28 shrink-0 truncate rounded bg-muted px-1.5 py-0.5" title={channelName}>{channelName}</span> : null}
                </span>
            </span>
        </span>
    );
}

function readRecentModelKeys() {
    try {
        const value = JSON.parse(window.localStorage.getItem(RECENT_MODELS_STORAGE_KEY) || "[]");
        return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string").slice(0, MAX_RECENT_MODELS) : [];
    } catch {
        return [];
    }
}

function rememberRecentModel(key: string) {
    const next = [key, ...readRecentModelKeys().filter((item) => item !== key)].slice(0, MAX_RECENT_MODELS);
    try {
        window.localStorage.setItem(RECENT_MODELS_STORAGE_KEY, JSON.stringify(next));
    } catch {
        // 浏览器禁止持久化时仍保留当前页面内的最近使用顺序。
    }
    window.dispatchEvent(new CustomEvent(RECENT_MODELS_EVENT, { detail: next }));
}

function ModelBadge({ label, tone, title }: { label: string; tone: "selected" | "neutral" | "danger"; title?: string }) {
    return <span title={title || label} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none ring-1", tone === "selected" && "bg-ring/15 text-foreground ring-ring/30", tone === "danger" && "bg-destructive/10 text-destructive ring-destructive/25", tone === "neutral" && "bg-muted text-muted-foreground ring-border/70")}>{label}</span>;
}

function modelStatus(protocol?: string, status?: ModelConnectionStatus): { label: string; tone: "selected" | "neutral" | "danger" } {
    if (protocol === "jimeng" && status === "connected") return { label: "待真实验证", tone: "neutral" };
    if (status === "connected") return { label: "可用", tone: "selected" };
    if (status === "failed") return { label: "连接失败", tone: "danger" };
    if (status === "timeout") return { label: "检测超时", tone: "danger" };
    if (status === "disabled") return { label: "已停用", tone: "danger" };
    if (status === "unavailable") return { label: "不可用", tone: "danger" };
    if (status === "untested") return { label: "未测试", tone: "neutral" };
    return { label: "已配置", tone: "neutral" };
}

function isUnavailableStatus(status?: ModelConnectionStatus) {
    return status === "disabled" || status === "unavailable";
}

function modelStatusRank(status?: ModelConnectionStatus) {
    if (status === "connected") return 0;
    if (!status || status === "untested") return 1;
    if (status === "failed" || status === "timeout") return 2;
    return 3;
}

function modelDisplayName(model: string, protocol?: string) {
    const suffix = CLI_PROTOCOLS.has(protocol || "") ? " · CLI" : "";
    const jimeng = jimengModelProfile(model);
    if (jimeng) return `${jimeng.label}${suffix}`;
    const gemini = model.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(high|medium|low))?$/i);
    if (gemini) return `Gemini ${gemini[1]} ${titleCase(gemini[2])}${gemini[3] ? ` · ${titleCase(gemini[3])}` : ""}${suffix}`;
    const claude = model.match(/^claude-(sonnet|opus)-(\d+)-(\d+)(?:-(thinking))?$/i);
    if (claude) return `Claude ${titleCase(claude[1])} ${claude[2]}.${claude[3]}${claude[4] ? " · Thinking" : ""}${suffix}`;
    const gptOss = model.match(/^gpt-oss-(\d+b)(?:-(high|medium|low))?$/i);
    if (gptOss) return `GPT-OSS ${gptOss[1].toUpperCase()}${gptOss[2] ? ` · ${titleCase(gptOss[2])}` : ""}${suffix}`;
    if (/^nano-banana-2$/i.test(model)) return `Nano Banana 2${suffix}`;
    return `${model}${suffix}`;
}

function titleCase(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
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
