"use client";

import { DeleteOutlined, EyeOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { App, Button, Card, Flex, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { deleteAdminAICallLogs, fetchAdminAICallLogs, fetchAdminSettings, saveAdminSettings, type AdminAICallLog } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export default function AdminAICallLogsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [total, setTotal] = useState(0);
    const [logs, setLogs] = useState<AdminAICallLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [clearDays, setClearDays] = useState(7);
    const [clearing, setClearing] = useState(false);
    const [detail, setDetail] = useState<{ title: string; value: string } | null>(null);
    const [localDirectReportEnabled, setLocalDirectReportEnabled] = useState(false);
    const [savingLocalDirectReport, setSavingLocalDirectReport] = useState(false);

    const loadLogs = async (nextKeyword = keyword) => {
        if (!token) return;
        setLoading(true);
        try {
            const result = await fetchAdminAICallLogs(token, { keyword: nextKeyword, page, pageSize });
            setLogs(result.items);
            setTotal(result.total);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 AI 调用日志失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadLogs();
    }, [token, page, pageSize]);

    useEffect(() => {
        if (!token) return;
        fetchAdminSettings(token)
            .then((settings) => setLocalDirectReportEnabled(settings.private.aiLog?.localDirectReportEnabled === true))
            .catch(() => undefined);
    }, [token]);

    const clearLogs = async () => {
        if (!token) return;
        setClearing(true);
        try {
            const result = await deleteAdminAICallLogs(token, clearDays);
            message.success(`已清理 ${result.removedFiles} 个日志文件`);
            setPage(1);
            await loadLogs();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清理 AI 调用日志失败");
        } finally {
            setClearing(false);
        }
    };

    const updateLocalDirectReport = async (checked: boolean) => {
        if (!token) return;
        const previous = localDirectReportEnabled;
        setLocalDirectReportEnabled(checked);
        setSavingLocalDirectReport(true);
        try {
            const settings = await fetchAdminSettings(token);
            await saveAdminSettings(token, {
                ...settings,
                private: {
                    ...settings.private,
                    aiLog: {
                        ...settings.private.aiLog,
                        localDirectReportEnabled: checked,
                    },
                },
            });
            message.success(checked ? "已开启本地直连日志上报" : "已关闭本地直连日志上报");
        } catch (error) {
            setLocalDirectReportEnabled(previous);
            message.error(error instanceof Error ? error.message : "保存本地直连日志设置失败");
        } finally {
            setSavingLocalDirectReport(false);
        }
    };

    const columns = useMemo(
        () => [
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => formatTime(value) },
            { title: "用户", dataIndex: "userDisplayName", width: 150, render: (_: string, item: AdminAICallLog) => item.userDisplayName || item.userId || "-" },
            { title: "接口", dataIndex: "endpoint", width: 170 },
            { title: "模型", dataIndex: "model", width: 180, ellipsis: true },
            { title: "渠道", dataIndex: "channelName", width: 150, ellipsis: true, render: (_: string, item: AdminAICallLog) => item.channelName || item.channelId || "-" },
            { title: "状态", dataIndex: "status", width: 90, render: (status: number, item: AdminAICallLog) => <Tag color={!item.failed && status >= 200 && status < 400 ? "success" : "error"}>{status || "失败"}</Tag> },
            { title: "耗时", dataIndex: "durationMs", width: 110, render: (value: number) => formatDuration(value) },
            { title: "扣点", dataIndex: "credits", width: 80 },
            {
                title: "操作",
                key: "actions",
                width: 180,
                fixed: "right" as const,
                render: (_: unknown, item: AdminAICallLog) => (
                    <Space size={6}>
                        <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail({ title: "请求详情", value: item.requestBody })}>
                            请求详情
                        </Button>
                        <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail({ title: "返回详情", value: item.responseBody || item.error })}>
                            返回详情
                        </Button>
                    </Space>
                ),
            },
        ],
        [],
    );

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16} className="w-full">
                <Card variant="borderless">
                    <Form
                        layout="vertical"
                        onFinish={() => {
                            setPage(1);
                            void loadLogs();
                        }}
                    >
                        <div className="flex flex-wrap items-center gap-3">
                            <Input className="min-w-[280px] flex-1 lg:max-w-[460px]" value={keyword} placeholder="搜索用户、模型、渠道、接口或错误" onChange={(event) => setKeyword(event.target.value)} />
                            <Button htmlType="submit" type="primary" icon={<SearchOutlined />}>
                                查询
                            </Button>
                            <Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); if (page === 1) void loadLogs(""); else setPage(1); }}>
                                重置
                            </Button>
                            <div className="flex h-8 items-center gap-2 rounded-md border border-stone-200 px-3 dark:border-stone-800">
                                <Typography.Text className="whitespace-nowrap text-sm">本地直连日志</Typography.Text>
                                <Switch size="small" checked={localDirectReportEnabled} loading={savingLocalDirectReport} onChange={(checked) => void updateLocalDirectReport(checked)} />
                            </div>
                            <div className="flex h-8 items-center gap-2">
                                <Typography.Text className="whitespace-nowrap text-sm">清理超过</Typography.Text>
                                <InputNumber min={1} value={clearDays} className="!w-24" onChange={(value) => setClearDays(Number(value) || 7)} />
                                <Typography.Text type="secondary" className="shrink-0">天前</Typography.Text>
                            </div>
                            <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={() => void clearLogs()} className="ml-0 lg:ml-auto">
                                清理旧日志
                            </Button>
                        </div>
                    </Form>
                </Card>
                <Card variant="borderless" title={<span>AI 调用日志 <Tag>{total} 条</Tag></span>}>
                    <Table
                        rowKey="id"
                        size="small"
                        loading={loading}
                        columns={columns}
                        dataSource={logs}
                        scroll={{ x: 1280 }}
                        pagination={{
                            current: page,
                            pageSize,
                            total,
                            showSizeChanger: true,
                            onChange: (nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            },
                        }}
                    />
                </Card>
            </Flex>
            <Modal title={detail?.title || "AI 调用详情"} open={Boolean(detail)} width="min(1100px, 92vw)" footer={null} onCancel={() => setDetail(null)} destroyOnHidden>
                <LogBlock value={detail?.value || ""} />
            </Modal>
        </main>
    );
}

function LogBlock({ value }: { value: string }) {
    return (
        <pre className="max-h-[72vh] whitespace-pre-wrap break-words overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200">{value || "-"}</pre>
    );
}

function formatTime(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "-";
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
}
