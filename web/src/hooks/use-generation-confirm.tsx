"use client";

import { useCallback } from "react";
import { App } from "antd";

import { channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";

export type GenerationTaskType = "图片生成" | "视频生成";

export function generationCallSummary(config: AiConfig, model: string, taskType: GenerationTaskType) {
    const scopedConfig = { ...config, model };
    const channel = config.channelMode === "remote"
        ? config.publicChannels.find((item) => item.id === channelIdForActiveModel(scopedConfig)) || config.publicChannels.find((item) => item.models.includes(model))
        : localChannelForActiveModel(scopedConfig);
    return {
        taskType,
        model: model || "未选择",
        channel: channel?.name || (config.channelMode === "remote" ? "云端渠道" : "本地直连"),
        protocol: channel?.protocol || "openai",
    };
}

export function useGenerationConfirm() {
    const { modal } = App.useApp();
    return useCallback((config: AiConfig, model: string, taskType: GenerationTaskType) => {
        const summary = generationCallSummary(config, model, taskType);
        return new Promise<boolean>((resolve) => {
            modal.confirm({
                title: "确认生成任务",
                content: (
                    <div className="grid gap-2 text-sm">
                        <div>调用渠道：{summary.channel}</div>
                        <div>模型：{summary.model}</div>
                        <div>任务类型：{summary.taskType}</div>
                        <div className="text-xs opacity-60">协议：{summary.protocol}</div>
                    </div>
                ),
                okText: "确认调用",
                cancelText: "取消",
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    }, [modal]);
}
