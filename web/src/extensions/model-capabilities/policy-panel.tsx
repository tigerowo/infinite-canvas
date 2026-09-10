"use client";

import { Alert, Button, Card, Collapse, Flex, Input, Select, Space, Table, Tag, Typography } from "antd";
import { FileText, Image as ImageIcon, Music, Video } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { loadModelPolicy, saveModelPolicy, type ModelKind, type ModelPolicy } from "./policy";
import type { AdminModelChannel } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const kindOptions = [
	{ value: "auto", label: <Space><FileText size={14} />自动识别</Space> },
    { value: "text", label: <Space><FileText size={14} />文本</Space> },
    { value: "image", label: <Space><ImageIcon size={14} />图片</Space> },
    { value: "video", label: <Space><Video size={14} />视频</Space> },
    { value: "audio", label: <Space><Music size={14} />音频</Space> },
];

export type ModelPolicyPanelHandle = {
    validateDraft: () => void;
    saveDraft: () => Promise<ModelPolicy>;
    reload: () => Promise<void>;
};

export const ModelPolicyPanel = forwardRef<ModelPolicyPanelHandle, { channels: AdminModelChannel[] }>(function ModelPolicyPanel({ channels }, ref) {
    const token = useUserStore((state) => state.token);
    const [policy, setPolicy] = useState<ModelPolicy>({ imageTransfer: "url", overrides: {} });
    const [keyword, setKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const load = async () => {
        setReady(false);
        try { setPolicy(await loadModelPolicy(true)); setError(""); setReady(true); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    };
    useEffect(() => { void load(); }, [token]);
    const rows = useMemo(() => channels.flatMap((channel) => channel.models.map((model) => ({
        key: channel.id + "::" + model.trim().toLowerCase(),
        model, channel: channel.name || "未命名渠道", protocol: channel.protocol, enabled: channel.enabled,
    }))), [channels]);
    const matching = rows.filter((row) => (row.model + " " + row.channel).toLowerCase().includes(keyword.toLowerCase()));
    const orphanOverrides = Object.keys(policy.overrides).filter((model) => !rows.some((row) => row.model.toLowerCase() === model));
    const orphanProfiles = Object.keys(policy.newapiVideoProfiles || {}).filter((key) => !rows.some((row) => row.key === key && row.protocol === "newapi"));
    const changeKind = (name: string, kind: string) => setPolicy((value) => {
        const overrides = { ...value.overrides };
        if (kind === "auto") delete overrides[name.toLowerCase()];
        else overrides[name.toLowerCase()] = kind as ModelKind;
        return { ...value, overrides };
    });
    const changeProfile = (key: string, profile: string) => setPolicy((value) => {
        const profiles = { ...value.newapiVideoProfiles };
        if (profile === "canvas-v1") profiles[key] = "canvas-v1";
        else delete profiles[key];
        return { ...value, newapiVideoProfiles: profiles };
    });
    const saveDraft = async () => {
        if (!token || !ready) throw new Error("模型与素材设置尚未加载完成");
        setLoading(true);
        try {
            const saved = await saveModelPolicy(token, policy);
            setPolicy(saved);
            return saved;
        } finally { setLoading(false); }
    };
    useImperativeHandle(ref, () => ({
        validateDraft: () => { if (!ready) throw new Error("模型与素材设置尚未加载完成，请稍后再保存"); },
        saveDraft,
        reload: load,
    }), [ready, saveDraft, load]);
    return <Card title="模型与素材传输" size="small">
        <Flex vertical gap={16}>
            {error && <Alert type="error" title={error} action={<Button onClick={() => void load()}>重试</Button>} />}
            <Space wrap>
                <span>参考图片传输</span>
                <Select aria-label="参考图片传输" disabled={!ready || loading} value={policy.imageTransfer}
                    onChange={(imageTransfer) => setPolicy((value) => ({ ...value, imageTransfer }))}
                    options={[{ value: "url", label: "图片链接" }, { value: "base64", label: "Base64 图片数据" }]} style={{ minWidth: 180 }} />
            </Space>
            <Typography.Text type="secondary">控制支持此设置的模型如何接收参考图片；图片链接需要模型服务能够访问。NewAPI 标准图片编辑和视频单图参考仍按接口要求上传文件。</Typography.Text>
            <Typography.Text>先在云端渠道中导入并保存模型，再点击每行右侧的类型切换。相同模型 ID 的分类会同时应用于各渠道；选择“自动识别”可取消手动分类。</Typography.Text>
            <Input.Search aria-label="搜索渠道模型" placeholder="搜索模型或渠道" value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear />
            <Table size="small" rowKey="key" dataSource={matching} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 520 }}
                locale={{ emptyText: "请先在云端渠道中导入并保存模型" }} columns={[
                    { title: "模型", dataIndex: "model", render: (model: string) => <span style={{ overflowWrap: "anywhere" }}>{model}</span> },
                    { title: "渠道", dataIndex: "channel", render: (name: string, row) => <Space>{name}{!row.enabled && <Tag>已停用</Tag>}</Space> },
                    { title: "类型", width: 140, align: "right", render: (_, row) => <Select size="small" aria-label={row.channel + " " + row.model + " 类型"} disabled={!ready || loading}
                        value={policy.overrides[row.model.toLowerCase()] || "auto"} options={kindOptions} onChange={(kind) => changeKind(row.model, kind)} style={{ width: 124 }} /> },
                ]} />
            {orphanOverrides.length > 0 && <Space wrap><Typography.Text type="secondary">未关联当前渠道的分类：</Typography.Text>{orphanOverrides.map((model) => <Tag key={model} closable onClose={() => changeKind(model, "auto")}>{model}：{policy.overrides[model]}</Tag>)}</Space>}
            <Collapse items={[{ key: "video-format", label: "高级：NewAPI 视频请求格式", children: <Flex vertical gap={12}>
                <Alert type="info" showIcon title="默认使用 NewAPI 标准视频接口" description="切换上面的模型类型，只会调整模型出现在哪个功能中。这里决定发送给 NewAPI 的请求格式。仅当对应 NewAPI 已安装支持 Canvas v1 的插件时，才为该模型选择 Canvas v1；它用于插件支持的多参考图、首尾帧等素材，不是所有上游都支持。更换网关或插件后请重新核对。" />
                <Table size="small" rowKey="key" dataSource={matching.filter((row) => row.protocol === "newapi")} pagination={{ pageSize: 5, hideOnSinglePage: true }} scroll={{ x: 520 }}
                    locale={{ emptyText: "暂无 NewAPI 渠道模型" }} columns={[
                        { title: "模型 / 渠道", render: (_, row) => <Flex vertical><span>{row.model}</span><Typography.Text type="secondary">{row.channel}</Typography.Text></Flex> },
                        { title: "视频请求格式", width: 220, render: (_, row) => <Select aria-label={row.channel + " " + row.model + " 视频请求格式"} disabled={!ready || loading}
                            value={policy.newapiVideoProfiles?.[row.key] || "standard"} style={{ width: "100%" }} onChange={(profile) => changeProfile(row.key, profile)}
                            options={[{ value: "standard", label: "标准接口（默认）" }, { value: "canvas-v1", label: "Canvas v1（需安装插件）" }]} /> },
                    ]} />
                {orphanProfiles.length > 0 && <Space wrap><Typography.Text type="secondary">原渠道已移除的扩展配置：</Typography.Text>{orphanProfiles.map((key) => <Tag key={key} closable onClose={() => changeProfile(key, "standard")}>{key}</Tag>)}</Space>}
            </Flex> }]} />
        </Flex>
    </Card>;
});
