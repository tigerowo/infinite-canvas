"use client";

import { useCallback } from "react";
import { App } from "antd";

import { modelChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";

export type GenerationTaskType = "图片生成" | "视频生成";

export function generationCallSummary(config: AiConfig, model: string, taskType: GenerationTaskType) {
    const scopedConfig = { ...config, model };
    const channel = modelChannelForActiveModel(scopedConfig);
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
                        {summary.model === "gpt-image-2" ? <div className="text-xs text-cyan-600">主路径：复用 Codex 登录态；不会自动回退到付费 OpenAI API。</div> : null}
                        {summary.model === "codex-image-emergency" ? <div className="text-xs text-amber-600">应急路径：本次将调用 codex exec，可能占用你的 Codex 开发额度。</div> : null}
                        {summary.model === "nano-banana-2" ? <div className="text-xs text-cyan-600">Google 登录路径：通过 Antigravity 内置 generate_image 工具调用；不会自动回退到付费 API。</div> : null}
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
