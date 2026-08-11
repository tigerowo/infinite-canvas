"use client";

import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Card, Checkbox, Col, Flex, Form, Input, InputNumber, Row, Select, Space, Switch, Table, Typography } from "antd";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { fetchAdminSettings, saveAdminSettings, type AdminModelCapability, type AdminModelCost, type AdminModelInfo, type AdminSettings } from "@/services/api/admin";
import { modelMatchesCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

import { collectChannelModels, emptySettings, finalizeSettingsForSave, modelCostCredits, modelInfoDescription, normalizeSettings, setModelCost, setModelDescription } from "../settings-shared";

// 模型能力可选项：与前端 image-settings-panel / video-settings-panel 保持一致
const IMAGE_ASPECT_OPTIONS = [
    { label: "1:1", value: "1:1" },
    { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "21:9", value: "21:9" },
];
const IMAGE_TIER_OPTIONS = [
    { label: "标准", value: "standard" },
    { label: "2K", value: "2k" },
    { label: "4K", value: "4k" },
];
const VIDEO_RESOLUTION_OPTIONS = [
    { label: "480p", value: "480p" },
    { label: "720p", value: "720p" },
    { label: "1080p", value: "1080p" },
    { label: "2K", value: "2k" },
    { label: "4K", value: "4k" },
];
const VIDEO_PANEL_TYPE_OPTIONS = [
    { label: "通用（默认）", value: "" },
    { label: "Kling 请求格式", value: "kling-v26" },
    { label: "Kling V3 请求格式", value: "kling-v3" },
    { label: "Seedance 请求格式", value: "seedance" },
    { label: "Grok 请求格式", value: "grok" },
    { label: "运动控制请求格式", value: "motion-control" },
    { label: "Agnes 请求格式", value: "agnes" },
];
const VIDEO_PROVIDER_OPTIONS = [
    { label: "不区分（空）", value: "" },
    { label: "apimart", value: "apimart" },
    { label: "kie", value: "kie" },
];
const VIDEO_RATIO_OPTIONS = [
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
    { label: "21:9", value: "21:9" },
    { label: "adaptive", value: "adaptive" },
];

function getModelCapability(items: AdminModelCapability[], model: string): AdminModelCapability {
    return items.find((item) => item.model === model) || { model, imageAspects: [], imageTiers: [], videoResolutions: [], videoSecondsMin: 4, videoSecondsMax: 20 };
}

function setModelCapabilityField(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, field: "imageAspects" | "imageTiers" | "videoResolutions" | "videoRatios", values: string[]) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], [field]: values };
    } else {
        next.push({ model, imageAspects: [], imageTiers: [], videoResolutions: [], [field]: values });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

function setModelCapabilitySeconds(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, field: "videoSecondsMin" | "videoSecondsMax", value: number | null) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const fallback = { model, imageAspects: [], imageTiers: [], videoResolutions: [], videoSecondsMin: 4, videoSecondsMax: 20 } as AdminModelCapability;
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], [field]: value ?? (field === "videoSecondsMin" ? 4 : 20) };
    } else {
        next.push({ ...fallback, [field]: value ?? (field === "videoSecondsMin" ? 4 : 20) });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

function setModelCapabilityValue(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, field: "videoPanelType" | "videoProvider" | "audioRequiresMode", value: string) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], [field]: value };
    } else {
        next.push({ model, imageAspects: [], imageTiers: [], videoResolutions: [], [field]: value });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

function setModelCapabilityBool(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, field: "videoSecondsSmart" | "supportsNegativePrompt" | "supportsFirstLastFrame" | "supportsFirstFrame" | "supportsMotionControl" | "supportsAudioGeneration" | "supportsWatermark" | "supportsMultiShot" | "supportsElementList", value: boolean) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], [field]: value };
    } else {
        next.push({ model, imageAspects: [], imageTiers: [], videoResolutions: [], [field]: value });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

function setModelCapabilityModes(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, modes: { value: string; label: string; desc?: string }[]) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], videoModes: modes };
    } else {
        next.push({ model, imageAspects: [], imageTiers: [], videoResolutions: [], videoModes: modes });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

function setModelCapabilityNumber(form: any, setModelCapabilities: (items: AdminModelCapability[]) => void, model: string, field: "audioMaxReferences" | "maxImageReferences" | "maxVideoReferences" | "maxAudioReferences", value: number | null) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCapabilities"]) || []) as AdminModelCapability[];
    const index = current.findIndex((item) => item.model === model);
    const next = [...current];
    if (index >= 0) {
        next[index] = { ...next[index], [field]: value ?? 0 };
    } else {
        next.push({ model, imageAspects: [], imageTiers: [], videoResolutions: [], [field]: value ?? 0 });
    }
    form.setFieldValue(["public", "modelChannel", "modelCapabilities"], next);
    setModelCapabilities(next);
}

export default function AdminModelPricingPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const [modelCapabilities, setModelCapabilities] = useState<AdminModelCapability[]>([]);
    const [modelInfos, setModelInfos] = useState<AdminModelInfo[]>([]);
    const [channels, setChannels] = useState<AdminSettings["private"]["channels"]>([]);
    const availableModels = (Form.useWatch(["public", "modelChannel", "availableModels"], form) || []) as string[];
    const allowCustomChannel = Form.useWatch(["public", "modelChannel", "allowCustomChannel"], form);
    const allowUserRemoteChannel = Form.useWatch(["public", "modelChannel", "allowUserRemoteChannel"], form);

    // 按渠道分组：每个启用渠道下的全部模型（不去重，保留渠道归属），用于勾选+定价一体化展示。
    // 同一模型被多渠道提供时会在每个渠道组下都出现一次，符合"在该渠道下定价该模型"的直觉。
    const channelGroups = useMemo(() => {
        return channels
            .filter((channel) => channel.enabled)
            .map((channel) => ({
                name: channel.name || "未命名渠道",
                models: Array.from(new Set((channel.models || []).filter(Boolean))) as string[],
            }))
            .filter((group) => group.models.length > 0);
    }, [channels]);

    const availableSet = useMemo(() => new Set(availableModels), [availableModels]);
    // 默认模型 Select options 按能力过滤，只显示对应类型的模型
    const textModelOptions = useMemo(() => availableModels.filter((m) => modelMatchesCapability(m, "text")).map((item) => ({ label: item, value: item })), [availableModels]);
    const imageModelOptions = useMemo(() => availableModels.filter((m) => modelMatchesCapability(m, "image")).map((item) => ({ label: item, value: item })), [availableModels]);
    const videoModelOptions = useMemo(() => availableModels.filter((m) => modelMatchesCapability(m, "video")).map((item) => ({ label: item, value: item })), [availableModels]);
    const audioModelOptions = useMemo(() => availableModels.filter((m) => modelMatchesCapability(m, "audio")).map((item) => ({ label: item, value: item })), [availableModels]);

    // 定价表数据：按渠道分组扁平化，渠道列用 rowSpan 合并首行，其余行 rowSpan=0
    const pricingTableData = useMemo(() => {
        const rows: Array<{ key: string; channel: string; model: string; channelRowSpan: number; groupModels: string[] }> = [];
        channelGroups.forEach((group) => {
            group.models.forEach((model, index) => {
                rows.push({
                    key: `${group.name}-${model}`,
                    channel: group.name,
                    model,
                    channelRowSpan: index === 0 ? group.models.length : 0,
                    groupModels: group.models,
                });
            });
        });
        return rows;
    }, [channelGroups]);

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            // 新模型默认全选：模型完全不在 modelCapabilities 里时填入全部选项（已存在的配置不动，包括用户手动清空的）。
            const caps = [...data.public.modelChannel.modelCapabilities];
            const existingModels = new Set(caps.map((c) => c.model));
            for (const model of data.public.modelChannel.availableModels) {
                if (existingModels.has(model)) continue;
                const isImage = modelMatchesCapability(model, "image");
                const isVideo = modelMatchesCapability(model, "video");
                if (!isImage && !isVideo) continue;
                caps.push({
                    model,
                    imageAspects: isImage ? IMAGE_ASPECT_OPTIONS.map((o) => o.value) : [],
                    imageTiers: isImage ? IMAGE_TIER_OPTIONS.map((o) => o.value) : [],
                    videoResolutions: isVideo ? VIDEO_RESOLUTION_OPTIONS.map((o) => o.value) : [],
                    videoSecondsMin: isVideo ? 4 : undefined,
                    videoSecondsMax: isVideo ? 20 : undefined,
                });
            }
            data.public.modelChannel.modelCapabilities = caps;
            form.setFieldsValue(data);
            setChannels(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setModelCapabilities(caps);
            setModelInfos(data.public.modelChannel.modelInfos);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取设置失败");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadSettings();
    }, [token]);

    const saveSettings = async () => {
        if (!token) return;
        setIsSaving(true);
        try {
            const rawValues = form.getFieldsValue(true) as AdminSettings;
            // modelInfos 通过 state 管理，避免 form store 读取丢失
            rawValues.public.modelChannel.modelInfos = modelInfos;
            const values = finalizeSettingsForSave(rawValues);
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            form.setFieldsValue(saved);
            setModelCosts(saved.public.modelChannel.modelCosts);
            setModelCapabilities(saved.public.modelChannel.modelCapabilities);
            setModelInfos(saved.public.modelChannel.modelInfos);
            message.success("已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setIsSaving(false);
        }
    };

    // 切换某个模型的开放状态：同步 availableModels 数组（去重）。
    const toggleModelAvailable = (model: string, checked: boolean) => {
        const current = (form.getFieldValue(["public", "modelChannel", "availableModels"]) || []) as string[];
        const next = checked ? Array.from(new Set([...current, model])) : current.filter((item) => item !== model);
        form.setFieldValue(["public", "modelChannel", "availableModels"], next);
    };

    // 渠道组全选/反选：把该组模型批量加入或移出 availableModels。
    const toggleGroupAvailable = (models: string[], checked: boolean) => {
        const current = (form.getFieldValue(["public", "modelChannel", "availableModels"]) || []) as string[];
        const set = new Set(current);
        if (checked) models.forEach((m) => set.add(m));
        else models.forEach((m) => set.delete(m));
        form.setFieldValue(["public", "modelChannel", "availableModels"], Array.from(set));
    };

    return (
        <main className="p-3 md:p-6">
            <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                <Flex vertical gap={16}>
                    <Card variant="borderless">
                        <Flex justify="space-between" align="center" gap={16} wrap>
                            <Typography.Title level={5} style={{ margin: 0 }}>
                                开放与定价
                            </Typography.Title>
                            <Space>
                                <Button icon={<ReloadOutlined />} loading={isLoading} onClick={() => void loadSettings()}>
                                    刷新
                                </Button>
                                <Button type="primary" icon={<SaveOutlined />} loading={isSaving} onClick={() => void saveSettings()}>
                                    保存设置
                                </Button>
                            </Space>
                        </Flex>
                    </Card>

                    <Card
                        variant="borderless"
                        title="模型开放与定价"
                        extra={<Typography.Text type="secondary">勾选 = 开放给用户，填写单价 = 每次调用扣除的算力点</Typography.Text>}
                    >
                        {channelGroups.length === 0 ? (
                            <Typography.Text type="secondary">
                                请先在<Link href="/admin/channels">模型管理</Link>添加并启用渠道
                            </Typography.Text>
                        ) : (
                            <Flex vertical gap={12}>
                                {/* 隐藏字段，保持 Form 对 availableModels 的绑定 */}
                                <Form.Item name={["public", "modelChannel", "availableModels"]} hidden>
                                    <InputNumber />
                                </Form.Item>
                                <Table
                                    rowKey="key"
                                    dataSource={pricingTableData}
                                    pagination={false}
                                    size="small"
                                    columns={[
                                        {
                                            title: "渠道",
                                            dataIndex: "channel",
                                            width: 180,
                                            onCell: (row) => ({ rowSpan: row.channelRowSpan }),
                                            render: (_, row) =>
                                                row.channelRowSpan > 0 ? (
                                                    <Space direction="vertical" size={0}>
                                                        <Checkbox
                                                            checked={row.groupModels.every((m) => availableSet.has(m))}
                                                            indeterminate={row.groupModels.some((m) => availableSet.has(m)) && !row.groupModels.every((m) => availableSet.has(m))}
                                                            onChange={(e) => toggleGroupAvailable(row.groupModels, e.target.checked)}
                                                        >
                                                            <Typography.Text strong>{row.channel}</Typography.Text>
                                                        </Checkbox>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 24 }}>
                                                            {row.groupModels.filter((m) => availableSet.has(m)).length}/{row.groupModels.length} 已开放
                                                        </Typography.Text>
                                                    </Space>
                                                ) : null,
                                        },
                                        {
                                            title: "模型",
                                            dataIndex: "model",
                                            width: 200,
                                            render: (value: string) => (
                                                <Typography.Text style={{ maxWidth: 180 }} ellipsis={{ tooltip: value }}>
                                                    {value}
                                                </Typography.Text>
                                            ),
                                        },
                                        {
                                            title: "描述",
                                            key: "description",
                                            width: 320,
                                            render: (_, row) => (
                                                <Input
                                                    size="small"
                                                    placeholder="模型介绍文案（选填）"
                                                    maxLength={30}
                                                    value={modelInfoDescription(modelInfos, row.model)}
                                                    onChange={(e) => setModelDescription(setModelInfos, row.model, e.target.value)}
                                                />
                                            ),
                                        },
                                        {
                                            title: "开放",
                                            key: "available",
                                            width: 80,
                                            align: "center",
                                            render: (_, row) => <Switch checked={availableSet.has(row.model)} onChange={(checked) => toggleModelAvailable(row.model, checked)} />,
                                        },
                                        {
                                            title: "单价",
                                            key: "credits",
                                            width: 160,
                                            render: (_, row) => (
                                                <Space.Compact>
                                                    <InputNumber
                                                        min={0}
                                                        step={1}
                                                        precision={0}
                                                        style={{ width: 100 }}
                                                        value={modelCostCredits(modelCosts, row.model)}
                                                        disabled={!availableSet.has(row.model)}
                                                        onChange={(value) => setModelCost(form, setModelCosts, row.model, Number(value) || 0)}
                                                    />
                                                    <span style={{ display: "flex", alignItems: "center", padding: "0 10px", border: "1px solid var(--ant-color-border)", borderLeft: 0, borderRadius: "0 6px 6px 0", background: "var(--ant-color-fill-quaternary)" }}>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>点</Typography.Text>
                                                    </span>
                                                </Space.Compact>
                                            ),
                                        },
                                    ]}
                                />
                            </Flex>
                        )}
                    </Card>

                    <Card
                        variant="borderless"
                        title="图片模型能力"
                        extra={<Typography.Text type="secondary">勾选每个图片模型支持的选项，未勾选 = 前端不展示；新模型默认全选</Typography.Text>}
                    >
                        {availableModels.length === 0 ? (
                            <Typography.Text type="secondary">请先在上方勾选开放模型</Typography.Text>
                        ) : (
                            <Flex vertical gap={12}>
                                <Form.Item name={["public", "modelChannel", "modelCapabilities"]} hidden>
                                    <InputNumber />
                                </Form.Item>
                                {availableModels
                                    .filter((model) => modelMatchesCapability(model, "image"))
                                    .map((model) => {
                                        const cap = getModelCapability(modelCapabilities, model);
                                        return (
                                            <div key={model} style={{ border: "1px solid var(--ant-color-border)", borderRadius: 8, padding: "12px 16px" }}>
                                                <Typography.Text strong style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
                                                <Flex gap={32} wrap style={{ marginTop: 8 }}>
                                                    <div style={{ minWidth: 320 }}>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>图片比例</Typography.Text>
                                                        <Checkbox.Group
                                                            options={IMAGE_ASPECT_OPTIONS}
                                                            value={cap.imageAspects}
                                                            onChange={(values) => setModelCapabilityField(form, setModelCapabilities, model, "imageAspects", values as string[])}
                                                        />
                                                    </div>
                                                    <div style={{ minWidth: 220 }}>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>图片档位</Typography.Text>
                                                        <Checkbox.Group
                                                            options={IMAGE_TIER_OPTIONS}
                                                            value={cap.imageTiers}
                                                            onChange={(values) => setModelCapabilityField(form, setModelCapabilities, model, "imageTiers", values as string[])}
                                                        />
                                                    </div>
                                                </Flex>
                                            </div>
                                        );
                                    })}
                            </Flex>
                        )}
                    </Card>

                    <Card
                        variant="borderless"
                        title="视频模型能力"
                        extra={<Typography.Text type="secondary">勾选每个视频模型支持的选项，未勾选 = 前端不展示；新模型默认全选</Typography.Text>}
                    >
                        {availableModels.length === 0 ? (
                            <Typography.Text type="secondary">请先在上方勾选开放模型</Typography.Text>
                        ) : (
                            <Flex vertical gap={12}>
                                {availableModels
                                    .filter((model) => modelMatchesCapability(model, "video"))
                                    .map((model) => {
                                        const cap = getModelCapability(modelCapabilities, model);
                                        return (
                                            <div key={model} style={{ border: "1px solid var(--ant-color-border)", borderRadius: 8, padding: "12px 16px" }}>
                                                <Typography.Text strong style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
                                                <Flex gap={32} wrap style={{ marginTop: 8 }}>
                                                    <div style={{ minWidth: 320 }}>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>视频分辨率</Typography.Text>
                                                        <Checkbox.Group
                                                            options={VIDEO_RESOLUTION_OPTIONS}
                                                            value={cap.videoResolutions}
                                                            onChange={(values) => setModelCapabilityField(form, setModelCapabilities, model, "videoResolutions", values as string[])}
                                                        />
                                                    </div>
                                                    <div style={{ minWidth: 220 }}>
                                                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>视频秒数范围（默认 4-20）</Typography.Text>
                                                        <Space>
                                                            <InputNumber
                                                                size="small"
                                                                min={1}
                                                                max={60}
                                                                value={cap.videoSecondsMin ?? 4}
                                                                onChange={(value) => setModelCapabilitySeconds(form, setModelCapabilities, model, "videoSecondsMin", value)}
                                                                style={{ width: 80 }}
                                                            />
                                                            <span style={{ color: "var(--ant-color-text-secondary)" }}>~</span>
                                                            <InputNumber
                                                                size="small"
                                                                min={1}
                                                                max={60}
                                                                value={cap.videoSecondsMax ?? 20}
                                                                onChange={(value) => setModelCapabilitySeconds(form, setModelCapabilities, model, "videoSecondsMax", value)}
                                                                style={{ width: 80 }}
                                                            />
                                                            <span style={{ color: "var(--ant-color-text-secondary)", fontSize: 12 }}>秒</span>
                                                        </Space>
                                                    </div>
                                                </Flex>
                                                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--ant-color-border)" }}>
                                                    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>视频能力配置（每个视频模型均可自由勾选，前端通用面板按勾选能力动态渲染）</Typography.Text>
                                                    <Flex gap={32} wrap>
                                                        <div style={{ minWidth: 180 }}>
                                                            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>请求体格式（控制后端请求字段映射）</Typography.Text>
                                                            <Select
                                                                size="small"
                                                                style={{ width: 180 }}
                                                                value={cap.videoPanelType || ""}
                                                                onChange={(value) => setModelCapabilityValue(form, setModelCapabilities, model, "videoPanelType", value)}
                                                                options={VIDEO_PANEL_TYPE_OPTIONS}
                                                            />
                                                        </div>
                                                        {(cap.videoPanelType === "kling-v3" || cap.videoPanelType === "motion-control") ? (
                                                            <div style={{ minWidth: 140 }}>
                                                                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>厂商（区分请求体格式）</Typography.Text>
                                                                <Select
                                                                    size="small"
                                                                    style={{ width: 120 }}
                                                                    value={cap.videoProvider || ""}
                                                                    onChange={(value) => setModelCapabilityValue(form, setModelCapabilities, model, "videoProvider", value)}
                                                                    options={VIDEO_PROVIDER_OPTIONS}
                                                                />
                                                            </div>
                                                        ) : null}
                                                        <div style={{ minWidth: 280 }}>
                                                            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>视频比例</Typography.Text>
                                                            <Checkbox.Group
                                                                options={VIDEO_RATIO_OPTIONS}
                                                                value={cap.videoRatios}
                                                                onChange={(values) => setModelCapabilityField(form, setModelCapabilities, model, "videoRatios", values as string[])}
                                                            />
                                                        </div>
                                                        <div style={{ minWidth: 320 }}>
                                                            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>视频模式（空=不支持模式选择）</Typography.Text>
                                                            <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                                                {(cap.videoModes || []).map((mode, modeIndex) => (
                                                                    <Space key={modeIndex} size={4}>
                                                                        <Input size="small" placeholder="值" style={{ width: 70 }} value={mode.value} onChange={(e) => setModelCapabilityModes(form, setModelCapabilities, model, (cap.videoModes || []).map((m, i) => i === modeIndex ? { ...m, value: e.target.value } : m))} />
                                                                        <Input size="small" placeholder="标签" style={{ width: 80 }} value={mode.label} onChange={(e) => setModelCapabilityModes(form, setModelCapabilities, model, (cap.videoModes || []).map((m, i) => i === modeIndex ? { ...m, label: e.target.value } : m))} />
                                                                        <Input size="small" placeholder="说明" style={{ width: 100 }} value={mode.desc || ""} onChange={(e) => setModelCapabilityModes(form, setModelCapabilities, model, (cap.videoModes || []).map((m, i) => i === modeIndex ? { ...m, desc: e.target.value } : m))} />
                                                                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => setModelCapabilityModes(form, setModelCapabilities, model, (cap.videoModes || []).filter((_, i) => i !== modeIndex))} />
                                                                    </Space>
                                                                ))}
                                                                <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setModelCapabilityModes(form, setModelCapabilities, model, [...(cap.videoModes || []), { value: "", label: "" }])}>添加模式</Button>
                                                            </Space>
                                                        </div>
                                                        <div style={{ minWidth: 280 }}>
                                                            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>能力开关</Typography.Text>
                                                            <Space size={[16, 8]} wrap>
                                                                <Checkbox checked={!!cap.supportsNegativePrompt} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsNegativePrompt", e.target.checked)}>负面提示词</Checkbox>
                                                                <Checkbox checked={!!cap.supportsFirstLastFrame} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsFirstLastFrame", e.target.checked)}>首尾帧</Checkbox>
                                                                <Checkbox checked={!!cap.supportsFirstFrame} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsFirstFrame", e.target.checked)}>首帧</Checkbox>
                                                                <Checkbox checked={!!cap.supportsMotionControl} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsMotionControl", e.target.checked)}>运动控制</Checkbox>
                                                                <Checkbox checked={!!cap.supportsAudioGeneration} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsAudioGeneration", e.target.checked)}>音频生成</Checkbox>
                                                                <Checkbox checked={!!cap.supportsWatermark} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsWatermark", e.target.checked)}>水印</Checkbox>
                                                                <Checkbox checked={!!cap.supportsMultiShot} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsMultiShot", e.target.checked)}>多镜头</Checkbox>
                                                                <Checkbox checked={!!cap.supportsElementList} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "supportsElementList", e.target.checked)}>元素列表</Checkbox>
                                                                <Checkbox checked={!!cap.videoSecondsSmart} onChange={(e) => setModelCapabilityBool(form, setModelCapabilities, model, "videoSecondsSmart", e.target.checked)}>智能时长(-1)</Checkbox>
                                                            </Space>
                                                        </div>
                                                        {cap.supportsAudioGeneration ? (
                                                            <div style={{ minWidth: 280 }}>
                                                                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>音频生成限制</Typography.Text>
                                                                <Space>
                                                                    <Select
                                                                        size="small"
                                                                        style={{ width: 120 }}
                                                                        placeholder="需要模式"
                                                                        value={cap.audioRequiresMode || ""}
                                                                        onChange={(value) => setModelCapabilityValue(form, setModelCapabilities, model, "audioRequiresMode", value)}
                                                                        options={[{ label: "不限", value: "" }, { label: "std", value: "std" }, { label: "pro", value: "pro" }, { label: "4k", value: "4k" }]}
                                                                    />
                                                                    <InputNumber
                                                                        size="small"
                                                                        min={0}
                                                                        max={10}
                                                                        placeholder="最大参考图"
                                                                        value={cap.audioMaxReferences || undefined}
                                                                        onChange={(value) => setModelCapabilityNumber(form, setModelCapabilities, model, "audioMaxReferences", value)}
                                                                        style={{ width: 120 }}
                                                                    />
                                                                </Space>
                                                            </div>
                                                        ) : null}
                                                        <div style={{ minWidth: 280 }}>
                                                            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>参考素材数量上限（0=默认）</Typography.Text>
                                                            <Space>
                                                                <InputNumber
                                                                    size="small"
                                                                    min={0}
                                                                    max={20}
                                                                    placeholder="图片"
                                                                    value={cap.maxImageReferences || undefined}
                                                                    onChange={(value) => setModelCapabilityNumber(form, setModelCapabilities, model, "maxImageReferences", value)}
                                                                    style={{ width: 90 }}
                                                                />
                                                                <InputNumber
                                                                    size="small"
                                                                    min={0}
                                                                    max={10}
                                                                    placeholder="视频"
                                                                    value={cap.maxVideoReferences || undefined}
                                                                    onChange={(value) => setModelCapabilityNumber(form, setModelCapabilities, model, "maxVideoReferences", value)}
                                                                    style={{ width: 90 }}
                                                                />
                                                                <InputNumber
                                                                    size="small"
                                                                    min={0}
                                                                    max={10}
                                                                    placeholder="音频"
                                                                    value={cap.maxAudioReferences || undefined}
                                                                    onChange={(value) => setModelCapabilityNumber(form, setModelCapabilities, model, "maxAudioReferences", value)}
                                                                    style={{ width: 90 }}
                                                                />
                                                            </Space>
                                                        </div>
                                                    </Flex>
                                                </div>
                                            </div>
                                        );
                                    })}
                            </Flex>
                        )}
                    </Card>

                    <Card variant="borderless" title="默认模型">
                        <Row gutter={16}>
                            <Col xs={24} md={6}>
                                <Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型">
                                    <Select showSearch allowClear options={textModelOptions} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name={["public", "modelChannel", "defaultImageModel"]} label="默认图片模型">
                                    <Select showSearch allowClear options={imageModelOptions} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型">
                                    <Select showSearch allowClear options={videoModelOptions} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name={["public", "modelChannel", "defaultAudioModel"]} label="默认音频模型">
                                    <Select showSearch allowClear options={audioModelOptions} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Card>

                    <Card variant="borderless" title="渠道策略">
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="允许用户自定义渠道" extra="开启后，前端可提供用户自定义 baseUrl 直连模式" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "allowUserRemoteChannel"]} label="允许普通用户使用云端渠道" extra="关闭后，普通用户只能使用本地直连；管理员仍可使用云端渠道" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                        </Row>
                        <Typography.Text type="secondary">
                            当前：{allowCustomChannel ? "用户可自带 API" : "用户不可自带 API"}
                            {allowUserRemoteChannel ? "，也可使用平台渠道" : "，仅管理员可用平台渠道"}
                        </Typography.Text>
                    </Card>
                </Flex>
            </Form>
        </main>
    );
}
