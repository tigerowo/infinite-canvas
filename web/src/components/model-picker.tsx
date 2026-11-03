"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAutoDLWorkflowNames } from "@/hooks/use-autodl-workflow";
import { isWorkflowProtocol } from "@/lib/model-channel";
import { cn } from "@/lib/utils";
import type { WorkflowRef } from "@/lib/workflow-channel";
import { filterModelsByCapability, normalizeLocalChannels, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    workflowRef?: WorkflowRef;
    onWorkflowChange?: (ref?: WorkflowRef) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

type PickerBase = { key: string; channelId?: string; channelName: string; protocol?: string; baseUrl?: string; modelAliases?: Record<string, string> };
type PickerOption = (PickerBase & { model: string }) | (PickerBase & { model: ""; workflowRef: WorkflowRef; label: string });

export function ModelPicker({ config, value, channelId, capability, onChange, workflowRef, onWorkflowChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const token = useUserStore((state) => state.token);
    const userReady = useUserStore((state) => state.isReady);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const workflowEnabled = Boolean(onWorkflowChange && capability && capability !== "text");
    const channelOptions = useMemo<PickerOption[]>(() => {
        const channels =
            config.channelMode === "remote"
                ? config.publicChannels.map((channel) => ({ id: channel.id, protocol: channel.protocol, name: channel.name || "云端渠道", baseUrl: channel.baseUrl, models: channel.models, modelAliases: channel.modelAliases || {}, modelCapabilities: channel.modelCapabilities, workflows: channel.workflows || [] }))
                : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, protocol: channel.protocol, name: channel.name || "本地渠道", baseUrl: channel.baseUrl, models: channel.models, modelAliases: channel.modelAliases || {}, modelCapabilities: channel.modelCapabilities, workflows: channel.workflowSummaries || [] }));
        const filtered = channels.filter((channel) => !isWorkflowProtocol(channel.protocol || "")).flatMap((channel) => filterModelsByCapability(channel.models ?? [], capability, channel.protocol || "", channel.modelCapabilities).map((model) => ({ key: `${channel.id}::${model}`, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, modelAliases: channel.modelAliases, model })));
        if (!workflowEnabled || !token) return filtered;
        const scope = config.channelMode === "remote" ? "system" : "personal";
        return [...filtered, ...channels.flatMap((channel) => isWorkflowProtocol(channel.protocol || "") ? channel.workflows.filter((entry) => entry.enabled && entry.capability === capability && entry.provider === channel.protocol).map((entry) => {
            const ref: WorkflowRef = { scope, channelId: channel.id || "", kind: entry.kind, workflowId: entry.workflowId };
            return { key: `workflow:${JSON.stringify([ref.scope, ref.channelId, ref.kind, ref.workflowId])}`, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, model: "", workflowRef: ref, label: entry.title || entry.workflowId };
        }) : [])];
    }, [capability, config, token, workflowEnabled]);
    const modelLabel = useAutoDLWorkflowNames(channelOptions);
    const currentOption = useMemo<PickerOption | undefined>(() => {
        if (workflowRef && workflowEnabled) return channelOptions.find((item) => "workflowRef" in item && item.key === `workflow:${JSON.stringify([workflowRef.scope, workflowRef.channelId, workflowRef.kind, workflowRef.workflowId])}`);
        if (!value) return undefined;
        return channelOptions.find((item) => item.model === value && item.channelId === channelId) || channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value, workflowEnabled, workflowRef]);
    const options = channelOptions;
    const current = workflowRef && workflowEnabled ? (currentOption && "label" in currentOption ? currentOption.label : "") : value || "";
    const currentValue = current && currentOption ? currentOption.key : "";

	useEffect(() => {
		if (workflowRef && workflowEnabled) {
			const workflowOptionsReady = workflowRef.scope === "system"
				? publicSettings !== null
				: config.workflowSyncTouched === true;
			if (token && userReady && workflowOptionsReady && !currentOption && channelOptions.some((item) => !("workflowRef" in item))) {
				onWorkflowChange?.(undefined);
            }
            return;
        }
        if (value && currentOption?.channelId && !("workflowRef" in currentOption) && channelId !== currentOption.channelId) onChange(value, currentOption.channelId);
	}, [channelId, channelOptions, config.workflowSyncTouched, currentOption, onChange, onWorkflowChange, publicSettings, token, userReady, value, workflowEnabled, workflowRef]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

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
                if (!option) return;
                if ("workflowRef" in option) onWorkflowChange?.(option.workflowRef);
                else { onChange(option.model, option.channelId); if (workflowRef) onWorkflowChange?.(undefined); }
            }}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={workflowRef && workflowEnabled && !currentOption ? "工作流已停用、未公开或删除，请重新选择" : pickerOptionLabel(current, currentOption, modelLabel) || current || placeholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{workflowRef && workflowEnabled ? current || "工作流已停用、未公开或删除，请重新选择" : pickerOptionLabel(current, currentOption, modelLabel) || placeholder}</span>
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
                    options.map((option) => (
                        <SelectItem key={option.key} value={option.key} textValue={`${"workflowRef" in option ? option.label : pickerOptionLabel(option.model, option, modelLabel)} ${option.model} ${option.channelName}`}>
                            <ModelLabel model={"workflowRef" in option ? option.workflowRef.workflowId : option.model} label={"workflowRef" in option ? `工作流 · ${option.label}` : pickerOptionLabel(option.model, option, modelLabel)} channelName={option.channelName} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {config.channelMode === "remote" ? "暂无可用模型" : "请先到配置里拉取模型列表"}
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

function pickerOptionLabel(model: string, option: PickerOption | undefined, modelLabel: (model: string, option?: { channelId?: string; channelName?: string; protocol?: string; baseUrl?: string }) => string) {
    if (!option || !model || "workflowRef" in option) return modelLabel(model, option);
    const alias = option.modelAliases?.[model]?.trim();
    if (alias) return alias;
    return modelLabel(model, option) || model;
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
