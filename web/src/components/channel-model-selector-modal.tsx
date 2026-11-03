"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { App, Button, Checkbox, Flex, Input, Modal, Segmented, Space, Tabs, Typography } from "antd";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useAutoDLWorkflowNames } from "@/hooks/use-autodl-workflow";
import { modelMatchesCapability, type ModelCapabilities, type ModelCapability } from "@/stores/use-config-store";

type ModelSelectTabKey = "new" | "current";
const ChannelParameterTranslationEditor = dynamic(() => import("@/components/channel-parameter-translation-editor").then((module) => module.ChannelParameterTranslationEditor), { ssr: false });
const capabilityOptions: Array<{ label: string; value: ModelCapability }> = [
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
];

type ChannelModelSelectorModalProps = {
    channel?: { name?: string; protocol?: string; baseUrl?: string; modelCapabilities?: ModelCapabilities; modelAliases?: Record<string, string> };
    parameterTranslation?: string;
    models: string[];
    modelAliases?: Record<string, string>;
    sourceModels?: string[];
    onCancel: () => void;
    onConfirm: (models: string[], modelAliases: Record<string, string>, modelCapabilities: ModelCapabilities, parameterTranslation: string) => void | Promise<void>;
    onFetchModels: () => Promise<string[] | undefined>;
    onModelsFetched?: (models: string[]) => void;
};

export function ChannelModelSelectorModal({ channel, parameterTranslation, models, modelAliases = {}, sourceModels = [], onCancel, onConfirm, onFetchModels, onModelsFetched }: ChannelModelSelectorModalProps) {
    const { message } = App.useApp();
    const modelLabel = useAutoDLWorkflowNames(channel ? [channel] : []);
    const [source, setSource] = useState(() => uniqueModels(sourceModels));
    const [existing, setExisting] = useState(() => uniqueModels(models));
    const [selected, setSelected] = useState(() => uniqueModels(models));
    const [keyword, setKeyword] = useState("");
    const [newModel, setNewModel] = useState("");
    const [activeTab, setActiveTab] = useState<ModelSelectTabKey | "classification" | "alias">("current");
    const [fetching, setFetching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [translation, setTranslation] = useState<string>();
    const [isTranslationOpen, setIsTranslationOpen] = useState(false);
    const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities>(() => ({ ...channel?.modelCapabilities }));
    const [modelAliasDraft, setModelAliasDraft] = useState<Record<string, string>>(() => normalizeModelAliases(modelAliases, models));
    const displayModelLabel = (model: string) => {
        const alias = (modelAliasDraft[model] || "").trim();
        const label = modelLabel(model, channel) || model;
        return alias ? `${alias} (${model})` : label;
    };
    const isClassifying = activeTab === "classification";
    const isAliasing = activeTab === "alias";
    const groups = useMemo(() => buildModelGroups(source, existing), [source, existing]);
    const activeModels = useMemo(() => {
        const normalizedKeyword = keyword.trim().toLowerCase();
        const current = activeTab === "classification" || activeTab === "alias" ? selected : groups[activeTab];
        return current.filter((model) => `${model} ${displayModelLabel(model)} ${modelAliasDraft[model] || ""}`.toLowerCase().includes(normalizedKeyword));
    }, [activeTab, groups, keyword, modelAliasDraft, modelLabel, selected]);
    const activeSelectedCount = activeModels.filter((model) => selected.includes(model)).length;

    const fetchModels = async () => {
        setActiveTab("new");
        setFetching(true);
        try {
            const fetchedModels = await onFetchModels();
            if (fetchedModels === undefined) return;
            onModelsFetched?.(fetchedModels);
            if (!fetchedModels.length) {
                message.warning("上游未返回模型列表，请手动输入模型名称");
                return;
            }
            const current = uniqueModels(selected);
            setExisting(current);
            setSource(uniqueModels(fetchedModels));
            setSelected(uniqueModels([...fetchedModels, ...current]));
            setKeyword("");
            setNewModel("");
            setActiveTab("new");
            message.success(`已获取 ${fetchedModels.length} 个模型，请选择后确认`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setFetching(false);
        }
    };

    const addModel = () => {
        const model = newModel.trim();
        if (!model) return;
        setExisting((current) => uniqueModels([...current, model]));
        setSelected((current) => uniqueModels([...current, model]));
        setNewModel("");
        setActiveTab("current");
    };

    const toggleModel = (model: string, checked: boolean) => {
        setSelected((current) => {
            if (checked) return uniqueModels([...current, model]);
            setModelAliasDraft((aliases) => {
                const next = { ...aliases };
                delete next[model];
                return next;
            });
            return current.filter((item) => item !== model);
        });
    };

    const selectActiveModels = () => setSelected((current) => uniqueModels([...current, ...activeModels]));
    const clearActiveModels = () => {
        const active = new Set(activeModels);
        setModelAliasDraft((current) => {
            const next = { ...current };
            for (const model of active) delete next[model];
            return next;
        });
        setSelected((current) => current.filter((model) => !active.has(model)));
    };
    const confirm = async () => {
        setSaving(true);
        try {
            await onConfirm(uniqueModels(selected), normalizeModelAliases(modelAliasDraft, selected), modelCapabilities, translation ?? parameterTranslation ?? "");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存渠道配置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
        <Modal
            title={
                <Space size={12}>
                    选择渠道模型
                    <Typography.Text type="secondary">
                        已选择 {selected.length} / {uniqueModels([...source, ...existing]).length}
                    </Typography.Text>
                </Space>
            }
            open
            width={960}
            onCancel={onCancel}
            footer={
                <Space>
                    <Button onClick={onCancel}>取消</Button>
                    <Button type="primary" loading={saving} onClick={() => void confirm()}>
                        确定
                    </Button>
                </Space>
            }
            destroyOnHidden
        >
            <Flex vertical gap={14}>
                <Flex gap={12} wrap>
                    <Input.Search placeholder="搜索模型" allowClear value={keyword} onChange={(event) => setKeyword(event.target.value)} style={{ flex: "1 1 260px" }} />
                    <Space.Compact style={{ flex: "1 1 320px" }}>
                        <Input value={newModel} placeholder={channel?.protocol === "autodl" ? "输入工作流 ID" : "输入模型名称"} onChange={(event) => setNewModel(event.target.value)} onPressEnter={addModel} />
                        <Button onClick={addModel}>增加模型</Button>
                        <Button icon={<ReloadOutlined />} loading={fetching} onClick={() => void fetchModels()}>
                            拉取模型列表
                        </Button>
                    </Space.Compact>
                </Flex>
                <Tabs
                    activeKey={activeTab}
                    styles={{ indicator: { display: isClassifying || isAliasing ? "none" : undefined } }}
                    onChange={(key) => setActiveTab(key as ModelSelectTabKey)}
                    items={[
                        { key: "new", label: `新获取的模型 (${groups.new.length})` },
                        { key: "current", label: `已有的模型 (${groups.current.length})` },
                    ]}
                />
                <Flex justify="space-between" align="center" gap={12} wrap>
                    <Typography.Text type="secondary">
                        当前列表已选择 {activeSelectedCount} / {activeModels.length}
                    </Typography.Text>
                    <Space size={8}>
                        <Button size="small" type={isClassifying ? "primary" : "default"} disabled={!selected.length} onClick={() => { setActiveTab("classification"); setKeyword(""); }}>
                            模型分类设置
                        </Button>
                        <Button size="small" type={isAliasing ? "primary" : "default"} disabled={!selected.length} onClick={() => { setActiveTab("alias"); setKeyword(""); }}>
                            模型别名设置
                        </Button>
                        <Button size="small" disabled={parameterTranslation === undefined} onClick={() => setIsTranslationOpen(true)}>
                            自定传参转译
                        </Button>
                        <Button size="small" disabled={isClassifying || isAliasing || !activeModels.length || activeSelectedCount === activeModels.length} onClick={selectActiveModels}>
                            全选当前列表
                        </Button>
                        <Button size="small" disabled={isClassifying || isAliasing || !activeSelectedCount} onClick={clearActiveModels}>
                            取消当前列表
                        </Button>
                    </Space>
                </Flex>
                <div style={{ maxHeight: 420, overflowY: "auto", scrollbarGutter: "stable", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                    {activeModels.length ? (
                        <div style={{ display: "grid", gridTemplateColumns: isClassifying || isAliasing ? "1fr" : "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12, paddingRight: isClassifying || isAliasing ? 5 : 0 }}>
                            {activeModels.map((model) => isClassifying ? (
                                <Flex key={model} justify="space-between" align="center" gap={16}>
                                    <Typography.Text title={model} style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>
                                        {displayModelLabel(model)}
                                    </Typography.Text>
                                    <Segmented
                                        size="small"
                                        options={capabilityOptions}
                                        value={capabilityOptions.find((option) => modelMatchesCapability(model, option.value, channel?.protocol, modelCapabilities))?.value ?? ""}
                                        onChange={(value) => setModelCapabilities((current) => ({ ...current, [model]: value as ModelCapability }))}
                                        style={{ flexShrink: 0 }}
                                    />
                                </Flex>
                            ) : isAliasing ? (
                                <Flex key={model} align="center" gap={16}>
                                    <Typography.Text title={model} style={{ flex: "0 0 340px", maxWidth: 340, wordBreak: "break-all" }}>
                                        {modelLabel(model, channel) || model}
                                    </Typography.Text>
                                    <Input
                                        allowClear
                                        placeholder="不填则前端显示原模型名"
                                        value={modelAliasDraft[model] || ""}
                                        onChange={(event) => setModelAliasDraft((current) => {
                                            const next = { ...current };
                                            next[model] = event.target.value;
                                            return next;
                                        })}
                                    />
                                </Flex>
                            ) : (
                                <Checkbox key={model} checked={selected.includes(model)} onChange={(event) => toggleModel(model, event.target.checked)}>
                                    <Typography.Text title={model} style={{ wordBreak: "break-all" }}>{displayModelLabel(model)}</Typography.Text>
                                </Checkbox>
                            ))}
                        </div>
                    ) : (
                        <div style={{ padding: "48px 0", textAlign: "center" }}>
                            <Typography.Text type="secondary">没有匹配的模型</Typography.Text>
                        </div>
                    )}
                </div>
            </Flex>
        </Modal>
        {isTranslationOpen && <ChannelParameterTranslationEditor name={channel?.name} baseUrl={channel?.baseUrl} models={selected} value={translation ?? parameterTranslation ?? ""} onSave={setTranslation} onClose={() => setIsTranslationOpen(false)} />}
        </>
    );
}

function buildModelGroups(sourceModels: string[], existingModels: string[]): Record<ModelSelectTabKey, string[]> {
    const source = uniqueModels(sourceModels);
    const existing = uniqueModels(existingModels);
    const existingSet = new Set(existing);
    return { new: source.filter((model) => !existingSet.has(model)), current: existing };
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

function normalizeModelAliases(aliases: Record<string, string>, models: string[]) {
    const allowed = new Set(uniqueModels(models));
    const next: Record<string, string> = {};
    for (const [model, alias] of Object.entries(aliases || {})) {
        const name = model.trim();
        if (!name || !allowed.has(name)) continue;
        next[name] = alias.trim();
    }
    return next;
}
