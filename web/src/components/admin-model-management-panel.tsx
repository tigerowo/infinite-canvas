"use client";

import { ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import { App, Button, Card, Flex, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";

import { ChannelModelSelectorModal } from "./channel-model-selector-modal";
import type { AdminModelChannel } from "@/services/api/admin";

type AdminModelManagementPanelProps = {
    channels: AdminModelChannel[];
    knownModels: string[];
    onFetchModels: (index: number) => Promise<string[]>;
    onUpdateChannelModels: (index: number, models: string[]) => void;
};

export function AdminModelManagementPanel({ channels, knownModels, onFetchModels, onUpdateChannelModels }: AdminModelManagementPanelProps) {
    const { message } = App.useApp();
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const [fetchingIndex, setFetchingIndex] = useState<number | null>(null);
    const [sourceModels, setSourceModels] = useState<string[]>([]);

    const openManager = (index: number) => {
        setActiveIndex(index);
        setSourceModels(knownModels);
    };

    const fetchModels = async (index: number): Promise<string[] | undefined> => {
        setFetchingIndex(index);
        try {
            const models = await onFetchModels(index);
            setSourceModels(models);
            setActiveIndex(index);
            if (!models.length) message.warning("上游未返回模型列表，请在管理模型中手动填写");
            return models;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
            return undefined;
        } finally {
            setFetchingIndex(null);
        }
    };

    return (
        <Card
            size="small"
            title="模型管理"
            extra={<Typography.Text type="secondary">先拉取并预览，确认后随顶部“保存设置”一起提交</Typography.Text>}
        >
            <Table
                size="small"
                pagination={false}
                scroll={{ x: 760 }}
                rowKey={(channel, index) => channel.id || `${index}-${channel.name}-${channel.baseUrl}`}
                dataSource={channels}
                locale={{ emptyText: "暂无渠道，请先新增渠道" }}
                columns={[
                    { title: "渠道名称", dataIndex: "name", render: (value: string) => value || "未命名渠道" },
                    { title: "协议", dataIndex: "protocol", width: 100, render: (value: string) => <Tag>{value || "openai"}</Tag> },
                    { title: "接口地址", dataIndex: "baseUrl", ellipsis: true, width: 260 },
                    { title: "状态", dataIndex: "enabled", width: 90, render: (value: boolean) => <Tag color={value ? "success" : "default"}>{value ? "已启用" : "已停用"}</Tag> },
                    { title: "模型数量", dataIndex: "models", width: 100, render: (value: string[]) => value?.length || 0 },
                    {
                        title: "操作",
                        key: "actions",
                        width: 270,
                        render: (_, channel, index) => (
                            <Flex gap={8} wrap>
                                <Button
                                    size="small"
                                    icon={<ReloadOutlined />}
                                    loading={fetchingIndex === index}
                                    onClick={() => void fetchModels(index)}
                                >
                                    拉取上游模型
                                </Button>
                                <Button size="small" icon={<SettingOutlined />} onClick={() => openManager(index)}>
                                    管理模型
                                </Button>
                            </Flex>
                        ),
                    },
                ]}
            />
            {activeIndex !== null && channels[activeIndex] ? (
                <ChannelModelSelectorModal
                    models={channels[activeIndex].models || []}
                    sourceModels={sourceModels}
                    onCancel={() => setActiveIndex(null)}
                    onConfirm={(models) => {
                        onUpdateChannelModels(activeIndex, models);
                        setActiveIndex(null);
                    }}
                    onFetchModels={() => onFetchModels(activeIndex)}
                />
            ) : null}
        </Card>
    );
}
