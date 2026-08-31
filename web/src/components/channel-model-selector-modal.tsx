"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { App, Button, Checkbox, Flex, Input, Modal, Space, Tabs, Typography } from "antd";
import { useMemo, useState } from "react";

type ModelSelectTabKey = "new" | "current";

type ChannelModelSelectorModalProps = {
    models: string[];
    sourceModels?: string[];
    onCancel: () => void;
    onConfirm: (models: string[]) => void;
    onFetchModels: () => Promise<string[] | undefined>;
    onModelsFetched?: (models: string[]) => void;
};

export function ChannelModelSelectorModal({ models, sourceModels = [], onCancel, onConfirm, onFetchModels, onModelsFetched }: ChannelModelSelectorModalProps) {
    const { message } = App.useApp();
    const [source, setSource] = useState(() => uniqueModels(sourceModels));
    const [existing, setExisting] = useState(() => uniqueModels(models));
    const [selected, setSelected] = useState(() => uniqueModels(models));
    const [keyword, setKeyword] = useState("");
    const [newModel, setNewModel] = useState("");
    const [activeTab, setActiveTab] = useState<ModelSelectTabKey>("current");
    const [fetching, setFetching] = useState(false);
    const groups = useMemo(() => buildModelGroups(source, existing), [source, existing]);
    const activeModels = useMemo(() => {
        const normalizedKeyword = keyword.trim().toLowerCase();
        return groups[activeTab].filter((model) => model.toLowerCase().includes(normalizedKeyword));
    }, [activeTab, groups, keyword]);
    const activeSelectedCount = activeModels.filter((model) => selected.includes(model)).length;

    const fetchModels = async () => {
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
        setSelected((current) => (checked ? uniqueModels([...current, model]) : current.filter((item) => item !== model)));
    };

    const selectActiveModels = () => setSelected((current) => uniqueModels([...current, ...activeModels]));
    const clearActiveModels = () => {
        const active = new Set(activeModels);
        setSelected((current) => current.filter((model) => !active.has(model)));
    };

    return (
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
                    <Button type="primary" onClick={() => onConfirm(uniqueModels(selected))}>
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
                        <Input value={newModel} placeholder="输入模型名称" onChange={(event) => setNewModel(event.target.value)} onPressEnter={addModel} />
                        <Button onClick={addModel}>增加模型</Button>
                        <Button icon={<ReloadOutlined />} loading={fetching} onClick={() => void fetchModels()}>
                            拉取模型列表
                        </Button>
                    </Space.Compact>
                </Flex>
                <Tabs
                    activeKey={activeTab}
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
                        <Button size="small" disabled={!activeModels.length || activeSelectedCount === activeModels.length} onClick={selectActiveModels}>
                            全选当前列表
                        </Button>
                        <Button size="small" disabled={!activeSelectedCount} onClick={clearActiveModels}>
                            取消当前列表
                        </Button>
                    </Space>
                </Flex>
                <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                    {activeModels.length ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12 }}>
                            {activeModels.map((model) => (
                                <Checkbox key={model} checked={selected.includes(model)} onChange={(event) => toggleModel(model, event.target.checked)}>
                                    <Typography.Text style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
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
