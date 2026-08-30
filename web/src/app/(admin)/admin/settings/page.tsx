"use client";

import { CheckCircleOutlined, DeleteOutlined, FormatPainterOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { json } from "@codemirror/lang-json";
import { Alert, App, Button, Card, Checkbox, Col, Drawer, Flex, Form, Input, InputNumber, Modal, Progress, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { EditorView } from "@uiw/react-codemirror";

import { modelChannelApiKeyUrls, modelChannelDefaultBaseUrls } from "@/lib/model-channel";
import { fetchAdminSettings, fetchChannelModels, measureAdminStorageProvider, saveAdminSettings, testChannelModel, type AdminModelChannel, type AdminModelCost, type AdminSettings, type AdminStorageProvider, type StorageCapacityResult } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const jsonEditorTheme = EditorView.theme({
    "&": { backgroundColor: "var(--ant-color-bg-container)", color: "var(--ant-color-text)" },
    ".cm-content": { caretColor: "var(--ant-color-text)", padding: "12px 0" },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": { backgroundColor: "var(--ant-color-fill-quaternary)", borderRight: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    ".cm-activeLine": { backgroundColor: "var(--ant-color-fill-quaternary)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--ant-color-fill-quaternary)", color: "var(--ant-color-text)" },
    ".cm-cursor": { borderLeftColor: "var(--ant-color-text)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ant-control-item-bg-active)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--ant-color-fill-quaternary)", border: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    "&.cm-focused": { outline: "none" },
});

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            modelCosts: [],
            channels: [],
            defaultModel: "",
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            systemPrompt: "",
            systemPrompts: { image: "", video: "", text: "", workflow: "", workflowAgent: "" },
            allowCustomChannel: true,
            allowUserRemoteChannel: false,
        },
        auth: { allowRegister: true, linuxDo: { enabled: false } },
        storage: { mode: "local_indexeddb", allowUserProvider: false },
    },
    private: { channels: [], promptSync: { enabled: true, cron: "0 0 * * *" }, aiLog: { localDirectReportEnabled: false, cleanup: { enabled: false, retentionDays: 14, cron: "0 3 * * *" } }, auth: { linuxDo: { clientId: "", clientSecret: "" } }, storage: { mode: "local_indexeddb", allowUserProvider: false, allowUserGlobalProvider: true, providers: [], roundRobinCursor: 0, capacityCheck: { enabled: false, cron: "0 */6 * * *" }, capacityLimitBytes: 9 * 1024 * 1024 * 1024, operationBudget: { enabled: true, classALimit: 1_000_000, classBLimit: 10_000_000, warningPercent: 80, stopPercent: 90 } } },
};
const emptyChannel: AdminModelChannel = { id: "", protocol: "openai", name: "", baseUrl: modelChannelDefaultBaseUrls.openai, apiKey: "", models: [], weight: 1, timeout: 600, enabled: true, remark: "" };
const emptyS3StorageProvider: AdminStorageProvider = { id: "", name: "", type: "s3", endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", publicBaseUrl: "", pathPrefix: "canvas", username: "", password: "", weight: 1, enabled: true, ownerUserId: "", capacityBytes: 0, capacityCheckedAt: "", capacityExceeded: false };
const emptyWebDAVStorageProvider: AdminStorageProvider = { ...emptyS3StorageProvider, name: "", type: "webdav", region: "" };

type SettingsTabKey = "public" | "private";
type EditorMode = "visual" | "json";
type ModelSelectTabKey = "new" | "current";

export default function AdminSettingsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [activeTab, setActiveTab] = useState<SettingsTabKey>("public");
    const [editorMode, setEditorMode] = useState<Record<SettingsTabKey, EditorMode>>({ public: "visual", private: "visual" });
    const [jsonText, setJsonText] = useState<Record<SettingsTabKey, string>>({ public: "", private: "" });
    const [channels, setChannels] = useState<AdminModelChannel[]>([]);
    const [channelForm] = Form.useForm<AdminModelChannel>();
    const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
    const [isChannelDrawerOpen, setIsChannelDrawerOpen] = useState(false);
    const [testChannelIndex, setTestChannelIndex] = useState<number | null>(null);
    const [testKeyword, setTestKeyword] = useState("");
    const [selectedTestModels, setSelectedTestModels] = useState<string[]>([]);
    const [testingModels, setTestingModels] = useState<string[]>([]);
    const [testResults, setTestResults] = useState<Record<string, { status: "success" | "error"; duration?: string; message: string }>>({});
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [modelSelectSource, setModelSelectSource] = useState<string[]>([]);
    const [modelSelectExisting, setModelSelectExisting] = useState<string[]>([]);
    const [modelSelectSelected, setModelSelectSelected] = useState<string[]>([]);
    const [modelSelectKeyword, setModelSelectKeyword] = useState("");
    const [modelSelectNewModel, setModelSelectNewModel] = useState("");
    const [modelSelectTab, setModelSelectTab] = useState<ModelSelectTabKey>("new");
    const [isFetchingChannelModels, setIsFetchingChannelModels] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [measuringProviderIndex, setMeasuringProviderIndex] = useState<number | null>(null);
    const [storageBudgetResults, setStorageBudgetResults] = useState<Record<number, StorageCapacityResult>>({});
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const [knownModels, setKnownModels] = useState<string[]>([]);
    const publicModels = Form.useWatch(["public", "modelChannel", "availableModels"], form) || [];
    const storageProviders = Form.useWatch(["private", "storage", "providers"], form) || [];
    const channelProtocol = Form.useWatch("protocol", channelForm);
    const channelApiKeyUrl = channelProtocol ? modelChannelApiKeyUrls[channelProtocol] : undefined;
    const channelModels = useMemo(() => collectChannelModels(channels), [channels]);
    const channelTableData = useMemo(() => channels.map((channel, index) => ({ ...channel, _index: index, _rowKey: `${index}-${channel.name}-${channel.baseUrl}` })), [channels]);
    const activeMode = editorMode[activeTab];
    const activeJsonText = jsonText[activeTab];
    const jsonError = activeMode === "json" ? getJsonError(activeJsonText) : "";
    const modelSelectGroups = useMemo(() => buildModelSelectGroups(modelSelectSource, modelSelectExisting), [modelSelectSource, modelSelectExisting]);
    const activeModelSelectModels = useMemo(() => {
        const keyword = modelSelectKeyword.trim().toLowerCase();
        return modelSelectGroups[modelSelectTab].filter((model) => model.toLowerCase().includes(keyword));
    }, [modelSelectGroups, modelSelectKeyword, modelSelectTab]);
    const activeSelectedCount = activeModelSelectModels.filter((model) => modelSelectSelected.includes(model)).length;

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(data);
            setChannels(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setKnownModels(collectKnownModels(data));
            setJsonText({
                public: JSON.stringify(data.public, null, 2),
                private: JSON.stringify(data.private, null, 2),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取设置失败");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadSettings();
    }, [token]);

    const changeTab = (nextTab: SettingsTabKey) => {
        setActiveTab(nextTab);
    };

    const saveSettings = async () => {
        if (!token) return;
        const values = await collectSettings(form, editorMode, jsonText, message);
        if (!values) {
            return;
        }
        setIsSaving(true);
        try {
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            const merged = mergeChannelApiKeys(values.private.channels, saved);
            form.setFieldsValue(merged);
            setChannels(merged.private.channels);
            setModelCosts(merged.public.modelChannel.modelCosts);
            rememberKnownModels(merged);
            setJsonText({
                public: JSON.stringify(merged.public, null, 2),
                private: JSON.stringify(merged.private, null, 2),
            });
            message.success("已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleMode = (tab: SettingsTabKey, nextMode: EditorMode) => {
        if (nextMode === "json") {
            setJsonText((current) => ({
                ...current,
                [tab]: JSON.stringify(tab === "public" ? normalizePublicSetting(form.getFieldValue(["public"]) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(form.getFieldValue(["private"]) as Partial<AdminSettings["private"]>), null, 2),
            }));
            setEditorMode((current) => ({ ...current, [tab]: nextMode }));
            return;
        }
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        form.setFieldsValue({ [tab]: parsed } as Partial<AdminSettings>);
        if (tab === "private") setChannels((parsed as AdminSettings["private"]).channels);
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        rememberKnownModels({ ...normalizeSettings(form.getFieldsValue(true) as AdminSettings), [tab]: parsed });
        setEditorMode((current) => ({ ...current, [tab]: nextMode }));
    };

    const formatJson = (tab: SettingsTabKey) => {
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        setJsonText((current) => ({
            ...current,
            [tab]: JSON.stringify(parsed, null, 2),
        }));
    };

    const openChannelDrawer = (index: number | null) => {
        setEditingChannelIndex(index);
        setIsChannelDrawerOpen(true);
        const channel = index === null ? emptyChannel : normalizeChannel(channels[index]);
        channelForm.setFieldsValue(channel);
        rememberModels(channel.models);
    };

    const closeChannelDrawer = () => {
        setIsChannelDrawerOpen(false);
        setEditingChannelIndex(null);
        channelForm.resetFields();
    };

    const saveChannel = async () => {
        const channel = normalizeChannel(await channelForm.validateFields());
        rememberModels(channel.models);
        const nextChannels = [...channels];
        if (editingChannelIndex === null) nextChannels.push(channel);
        else nextChannels[editingChannelIndex] = channel;
        await persistChannels(nextChannels);
        closeChannelDrawer();
    };

    const fetchChannelModelList = async () => {
        if (!token) return;
        const channel = channelForm.getFieldsValue();
        if (!channel?.baseUrl) {
            message.warning("请先填写接口地址");
            return;
        }
        if (editingChannelIndex === null && !channel?.apiKey) {
            message.warning("请先填写 API Key");
            return;
        }
        setIsFetchingChannelModels(true);
        try {
            const channelModels = await fetchChannelModels(token, { index: editingChannelIndex ?? undefined, channel: normalizeChannel(channel) });
            const current = isModelSelectorOpen ? uniqueModels(modelSelectSelected) : uniqueModels(channelForm.getFieldValue("models") || []);
            rememberModels(channelModels);
            if (!channelModels.length) {
                message.warning("上游未返回模型列表，请手动输入模型名称");
                return;
            }
            setModelSelectExisting(current);
            setModelSelectSource(uniqueModels(channelModels));
            setModelSelectSelected(uniqueModels([...channelModels, ...current]));
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setModelSelectTab("new");
            setIsModelSelectorOpen(true);
            message.success(`已获取 ${channelModels.length} 个模型，请选择后确认`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setIsFetchingChannelModels(false);
        }
    };

    const openChannelModelSelector = (sourceModels?: string[]) => {
        const current = uniqueModels(channelForm.getFieldValue("models") || []);
        const source = uniqueModels(sourceModels !== undefined ? sourceModels : [...knownModels, ...current]);
        setModelSelectExisting(current);
        setModelSelectSource(source);
        setModelSelectSelected(sourceModels ? uniqueModels([...current, ...source]) : current);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
        setModelSelectTab(sourceModels ? "new" : "current");
        setIsModelSelectorOpen(true);
    };

    const closeChannelModelSelector = () => {
        setIsModelSelectorOpen(false);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
    };

    const confirmChannelModelSelector = () => {
        const models = uniqueModels(modelSelectSelected);
        channelForm.setFieldValue("models", models);
        rememberModels(models);
        closeChannelModelSelector();
    };

    const toggleSelectedModel = (model: string, checked: boolean) => {
        setModelSelectSelected((current) => (checked ? uniqueModels([...current, model]) : current.filter((item) => item !== model)));
    };

    const selectActiveModels = () => {
        setModelSelectSelected((current) => uniqueModels([...current, ...activeModelSelectModels]));
    };

    const clearActiveModels = () => {
        const active = new Set(activeModelSelectModels);
        setModelSelectSelected((current) => current.filter((model) => !active.has(model)));
    };

    const addModelInSelector = () => {
        const model = modelSelectNewModel.trim();
        if (!model) return;
        setModelSelectExisting((current) => uniqueModels([...current, model]));
        setModelSelectSelected((current) => uniqueModels([...current, model]));
        setModelSelectNewModel("");
        setModelSelectTab("current");
    };

    function rememberModels(models: string[]) {
        setKnownModels((current) => uniqueModels([...current, ...models]));
    }

    function rememberKnownModels(settings: AdminSettings) {
        rememberModels(collectKnownModels(settings));
    }

    const openTestDialog = (index: number) => {
        const channel = normalizeChannel(channels[index]);
        if (!channel.baseUrl || channel.models.length === 0) {
            message.warning("请先填写接口地址和至少一个模型");
            return;
        }
        setTestChannelIndex(index);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const closeTestDialog = () => {
        setTestChannelIndex(null);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const testModelOnline = async (model: string) => {
        if (testChannelIndex === null) return;
        if (!token) return;
        const channel = normalizeChannel(channels[testChannelIndex]);
        setTestingModels((current) => [...current, model]);
        try {
            const startedAt = performance.now();
            const result = await testChannelModel(token, { index: testChannelIndex, channel, model });
            setTestResults((current) => ({ ...current, [model]: { status: "success", duration: `${((performance.now() - startedAt) / 1000).toFixed(2)}s`, message: result } }));
        } catch (error) {
            setTestResults((current) => ({ ...current, [model]: { status: "error", message: error instanceof Error ? error.message : "测试失败" } }));
        } finally {
            setTestingModels((current) => current.filter((item) => item !== model));
        }
    };

    const batchTestModels = async () => {
        for (const model of selectedTestModels) {
            await testModelOnline(model);
        }
    };

    const testChannel = testChannelIndex === null ? null : normalizeChannel(channels[testChannelIndex]);
    const testModels = (testChannel?.models || []).filter((model) => model.toLowerCase().includes(testKeyword.trim().toLowerCase()));

    async function persistChannels(nextChannels: AdminModelChannel[]) {
        if (!token) return;
        const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
        const nextChannelModels = collectChannelModels(nextChannels);
        const nextSettings = normalizeSettings({
            ...values,
            public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: filterModels(values.public.modelChannel.availableModels, nextChannelModels) } },
            private: { ...values.private, channels: nextChannels },
        });
        const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
        const merged = mergeChannelApiKeys(nextChannels, saved);
        setChannels(merged.private.channels);
        setModelCosts(merged.public.modelChannel.modelCosts);
        rememberKnownModels(merged);
        form.setFieldsValue(merged);
        setJsonText({
            public: JSON.stringify(merged.public, null, 2),
            private: JSON.stringify(merged.private, null, 2),
        });
        message.success("已保存");
    }

    async function measureStorageProviderAt(index: number) {
        if (!token) return;
        const provider = normalizeStorageProvider(form.getFieldValue(["private", "storage", "providers", index]));
        setMeasuringProviderIndex(index);
        try {
            const result = await measureAdminStorageProvider(token, { index, provider });
            setStorageBudgetResults((current) => ({ ...current, [index]: result }));
            const next = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(next);
            setJsonText({ public: JSON.stringify(next.public, null, 2), private: JSON.stringify(next.private, null, 2) });
            message.success(`预算明细已刷新：${formatStorageBytes(result.bytes)}${result.writeProtected ? "，新写入保护已开启" : ""}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringProviderIndex(null);
        }
    }

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap>
                        <Tabs
                            activeKey={activeTab}
                            onChange={(key) => changeTab(key as SettingsTabKey)}
                            items={[
                                { key: "public", label: "公开配置（对外暴露）" },
                                { key: "private", label: "私有配置（不会对外暴露）" },
                            ]}
                        />
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

                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap style={{ marginBottom: 16 }}>
                        <Segmented
                            value={activeMode}
                            onChange={(value) => toggleMode(activeTab, value as EditorMode)}
                            options={[
                                { label: "可视化编辑", value: "visual" },
                                { label: "手动编辑 JSON", value: "json" },
                            ]}
                        />
                        {activeMode === "json" ? (
                            <Space>
                                {jsonError ? (
                                    <Tag color="error">{jsonError}</Tag>
                                ) : (
                                    <Tag color="success" icon={<CheckCircleOutlined />}>
                                        JSON 格式正确
                                    </Tag>
                                )}
                                <Button icon={<FormatPainterOutlined />} onClick={() => formatJson(activeTab)}>
                                    格式化
                                </Button>
                            </Space>
                        ) : (
                            <Typography.Text type="secondary">{activeTab === "public" ? "这些配置会暴露给前端读取" : "这些配置只会在后台保存"}</Typography.Text>
                        )}
                    </Flex>

                    {activeTab === "public" ? (
                        activeMode === "visual" ? (
                            <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                                <Row gutter={16}>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "availableModels"]} label="系统可用模型(请先在私有配置里配置渠道)" extra="可选项来自已启用渠道中选择的模型，最终开放哪些模型由这里勾选决定">
                                            <Select mode="multiple" placeholder="请选择系统可用模型" options={channelModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultModel"]} label="默认模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultImageModel"]} label="默认图片模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>内置/系统提示词</Typography.Title>
                                        <Row gutter={16}>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "image"]} label="生图系统提示词">
                                                    <Input.TextArea rows={4} placeholder="会自动追加在生图提示词前，不在输入框中展示" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "video"]} label="视频系统提示词">
                                                    <Input.TextArea rows={4} placeholder="会自动追加在视频提示词前" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "text"]} label="文本/问答系统提示词">
                                                    <Input.TextArea rows={4} placeholder="用于画布问答、AI 文本等文本模型调用" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "workflow"]} label="工作流运行系统提示词">
                                                    <Input.TextArea rows={4} placeholder="用于工作流运行时补充统一创作要求" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "workflowAgent"]} label="工作流创建 Agent 系统提示词">
                                                    <Input.TextArea rows={6} placeholder="控制 AI 创建工作流的输出规范和默认参数" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Form.Item name={["public", "modelChannel", "systemPrompt"]} hidden>
                                            <Input />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="是否允许用户自定义渠道" extra="开启后，前端可提供用户自定义 baseUrl 直连模式" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowUserRemoteChannel"]} label="是否允许普通用户使用云端渠道" extra="关闭后，普通用户只能使用本地直连；管理员仍可使用云端渠道" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "auth", "allowRegister"]} label="是否允许用户注册" extra="关闭后隐藏注册入口，注册接口也会拒绝新用户创建" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>模型算力点</Typography.Title>
                                        <Table
                                            rowKey="model"
                                            pagination={false}
                                            size="small"
                                            dataSource={publicModels.map((model) => ({ model, credits: modelCostCredits(modelCosts, model) }))}
                                            columns={[
                                                { title: "模型", dataIndex: "model" },
                                                {
                                                    title: "每次调用扣除",
                                                    dataIndex: "credits",
                                                    width: 220,
                                                    render: (_, item) => (
                                                        <Space.Compact className="!w-full">
                                                            <InputNumber min={0} step={1} precision={0} className="!w-full" value={item.credits} onChange={(value) => setModelCost(form, setModelCosts, item.model, Number(value) || 0)} />
                                                            <span className="flex h-8 items-center rounded-r-md border border-l-0 border-stone-200 bg-stone-50 px-3 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
                                                                点
                                                            </span>
                                                        </Space.Compact>
                                                    ),
                                                },
                                            ]}
                                        />
                                    </Col>
                                </Row>
                            </Form>
                        ) : (
                            <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                                <CodeMirror
                                    value={activeJsonText}
                                    height="520px"
                                    extensions={[json(), jsonEditorTheme]}
                                    basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                    theme="none"
                                    onChange={(value) => setJsonText((current) => ({ ...current, public: value }))}
                                    style={{ fontSize: 13 }}
                                />
                            </div>
                        )
                    ) : activeMode === "visual" ? (
                        <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                            <Flex vertical gap={12}>
                                <Card
                                    size="small"
                                    title={
                                        <Space>
                                            <img src="/icons/linuxdo.svg" alt="" width={18} height={18} />
                                            Linux.do 登录
                                        </Space>
                                    }
                                >
                                    <Flex vertical gap={14}>
                                        <Typography.Text type="secondary">
                                            本项目接口回调地址是 /api/auth/linux-do/callback，请在 Linux.do 应用后台自行拼接站点前缀。
                                            <Typography.Link href="https://connect.linux.do" target="_blank" rel="noreferrer">
                                                点击此处管理你的 LinuxDO OAuth App
                                            </Typography.Link>
                                        </Typography.Text>
                                        <Row gutter={16}>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["public", "auth", "linuxDo", "enabled"]} label="开启 Linux.do 登录" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientId"]} label="Linux.do Client ID">
                                                    <Input placeholder="输入 Linux.do OAuth App 的 ID" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientSecret"]} label="Linux.do Client Secret">
                                                    <Input.Password placeholder="留空则沿用已保存的密钥" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                    </Flex>
                                </Card>
                                <Card size="small" title="提示词定时同步">
                                    <Row gutter={16} align="middle">
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "promptSync", "enabled"]} label="开启定时同步" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={16}>
                                            <Form.Item name={["private", "promptSync", "cron"]} label="Cron 表达式" extra="默认每天 0 点同步内置 GitHub 远程提示词源">
                                                <Input placeholder="0 0 * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Card size="small" title="AI 调用日志">
                                    <Row gutter={16}>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "localDirectReportEnabled"]} label="本地直连日志上报" valuePropName="checked" extra="关闭后本地直连不上报；云端渠道仍默认记录。">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "enabled"]} label="开启自动清理" valuePropName="checked" extra="日志按天写入本地文件，不保存到 SQLite。">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "retentionDays"]} label="保留天数" extra="默认保留 14 天，超过后定时删除对应日期日志文件。">
                                                <InputNumber min={1} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "cron"]} label="清理 Cron">
                                                <Input placeholder="0 3 * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Card size="small" title="数据存储">
                                    <Row gutter={16}>
                                        <Col xs={24} md={8}>
                                            <Form.Item label="存储模式" extra="自动检测：当配置并启用任意对象存储时，系统自动开启云端同步。">
                                                <Input disabled value="自动识别 (动态切换)" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "allowUserProvider"]} label="允许用户配置 S3/WebDAV" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "allowUserGlobalProvider"]} label="允许用户使用全局配置渠道" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityCheck", "enabled"]} label="定时统计容量" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityCheck", "cron"]} label="容量统计 Cron">
                                                <Input placeholder="0 */6 * * *" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityLimitBytes"]} label="容量写入保护线(字节)" extra="默认 9GB；达到后停止新写入，已有素材仍可读取和删除。">
                                                <InputNumber min={1} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "operationBudget", "enabled"]} label="月度操作预算保护" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "operationBudget", "classALimit"]} label="A 类月额度">
                                                <InputNumber min={1} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "operationBudget", "classBLimit"]} label="B 类月额度">
                                                <InputNumber min={1} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={12} md={3}>
                                            <Form.Item name={["private", "storage", "operationBudget", "warningPercent"]} label="预警比例(%)">
                                                <InputNumber min={1} max={99} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={12} md={3}>
                                            <Form.Item name={["private", "storage", "operationBudget", "stopPercent"]} label="保护比例(%)">
                                                <InputNumber min={1} max={100} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                    <Alert showIcon type="info" title="操作次数为 Infinite Canvas 本机估算，不等同于 Cloudflare 账单；达到容量或 A 类保护线时仅停止新云端写入并回退本机，B 类接近额度时预警但不切断历史素材。" />
                                    <Form.List name={["private", "storage", "providers"]}>
                                        {(fields, { add, remove }) => (
                                            <Flex vertical gap={12}>
                                                <Button icon={<PlusOutlined />} onClick={() => add(newAdminStorageProvider("s3", storageProviders))}>
                                                    新增 S3/R2 配置
                                                </Button>
                                                <Button icon={<PlusOutlined />} onClick={() => add(newAdminStorageProvider("webdav", storageProviders))}>
                                                    新增 WebDAV 配置
                                                </Button>
                                                {fields.map((field) => {
                                                    const provider = storageProviders[field.name] || emptyS3StorageProvider;
                                                    const isWebDAV = provider.type === "webdav";
                                                    const weightField = (
                                                        <Col xs={24} md={3}>
                                                            <Form.Item name={[field.name, "weight"]} label="权重">
                                                                <InputNumber min={1} className="!w-full" />
                                                            </Form.Item>
                                                        </Col>
                                                    );
                                                    return (
                                                        <Card
                                                            key={field.key}
                                                            size="small"
                                                            title={isWebDAV ? "WebDAV" : "S3/R2"}
                                                            extra={
                                                                <Flex gap={8}>
                                                                    <Button size="small" loading={measuringProviderIndex === field.name} onClick={() => void measureStorageProviderAt(field.name)}>
                                                                        刷新预算明细
                                                                    </Button>
                                                                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                                                                </Flex>
                                                            }
                                                        >
                                                            <Form.Item name={[field.name, "type"]} hidden>
                                                                <Input />
                                                            </Form.Item>
                                                            <Row gutter={12}>
                                                                <Col xs={24} md={6}>
                                                                    <Form.Item name={[field.name, "name"]} label="名称">
                                                                        <Input placeholder={isWebDAV ? "WebDAV" : "Cloudflare R2"} />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={isWebDAV ? 8 : 6}>
                                                                    <Form.Item name={[field.name, "endpoint"]} label={isWebDAV ? "WebDAV 地址" : "Endpoint"}>
                                                                        <Input placeholder={isWebDAV ? "https://dav.example.com/webdav" : "https://<account>.r2.cloudflarestorage.com"} />
                                                                    </Form.Item>
                                                                </Col>
                                                                {!isWebDAV && (
                                                                    <>
                                                                        <Col xs={24} md={4}>
                                                                            <Form.Item name={[field.name, "region"]} label="Region">
                                                                                <Input placeholder="auto" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={4}>
                                                                            <Form.Item name={[field.name, "bucket"]} label="Bucket">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                    </>
                                                                )}
                                                                <Col xs={24} md={4}>
                                                                    <Form.Item name={[field.name, "enabled"]} label="启用" valuePropName="checked">
                                                                        <Switch
                                                                            onChange={(checked) => {
                                                                                if (!checked) return;
                                                                                const providers = form.getFieldValue(["private", "storage", "providers"]) || [];
                                                                                const type = form.getFieldValue(["private", "storage", "providers", field.name, "type"]);
                                                                                providers.forEach((item: AdminStorageProvider, i: number) => {
                                                                                    if (i !== field.name && item.type !== type) {
                                                                                        form.setFieldValue(["private", "storage", "providers", i, "enabled"], false);
                                                                                    }
                                                                                });
                                                                            }}
                                                                        />
                                                                    </Form.Item>
                                                                </Col>
                                                                {isWebDAV && weightField}
                                                                {isWebDAV ? (
                                                                    <>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "pathPrefix"]} label="远程目录">
                                                                                <Input placeholder="请输入远程目录" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "username"]} label="用户名">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "password"]} label="密码 / 应用密码">
                                                                                <Input.Password placeholder="留空沿用已保存密码" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={0} md={6} />
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "accessKeyId"]} label="Access Key ID">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "secretAccessKey"]} label="Secret Access Key">
                                                                                <Input.Password placeholder="留空沿用已保存密钥" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "publicBaseUrl"]} label="公开访问域名">
                                                                                <Input placeholder="可选，不填则走后端代理读取" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={3}>
                                                                            <Form.Item name={[field.name, "pathPrefix"]} label="路径前缀">
                                                                                <Input placeholder="canvas" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        {weightField}
                                                                    </>
                                                                )}
                                                                <Col xs={24} md={4}>
                                                                    <Form.Item label="已用容量">
                                                                        <Typography.Text>{formatStorageBytes(form.getFieldValue(["private", "storage", "providers", field.name, "capacityBytes"]) || 0)}</Typography.Text>
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={5}>
                                                                    <Form.Item name={[field.name, "capacityCheckedAt"]} label="统计时间">
                                                                        <Input disabled />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={3}>
                                                                    <Form.Item name={[field.name, "capacityExceeded"]} label="超限" valuePropName="checked">
                                                                        <Switch disabled />
                                                                    </Form.Item>
                                                                </Col>
                                                            </Row>
                                                            {!isWebDAV && (
                                                                <StorageBudgetDetails result={storageBudgetResults[field.name]} />
                                                            )}
                                                        </Card>
                                                    );
                                                })}
                                            </Flex>
                                        )}
                                    </Form.List>
                                </Card>
                                <Button type="primary" icon={<PlusOutlined />} onClick={() => openChannelDrawer(null)}>
                                    新增渠道
                                </Button>
                                <Table
                                    rowKey="_rowKey"
                                    pagination={false}
                                    dataSource={channelTableData}
                                    columns={[
                                        { title: "名称", dataIndex: "name", render: (value) => value || "未命名渠道" },
                                        { title: "协议", dataIndex: "protocol", width: 96, render: (value) => <Tag>{value || "openai"}</Tag> },
                                        { title: "状态", dataIndex: "enabled", width: 96, render: (value) => <Tag color={value ? "success" : "default"}>{value ? "已启用" : "已停用"}</Tag> },
                                        {
                                            title: "模型",
                                            dataIndex: "models",
                                            render: (value: string[]) => (
                                                <Typography.Text ellipsis style={{ maxWidth: 360 }}>
                                                    {modelSummary(value || [])}
                                                </Typography.Text>
                                            ),
                                        },
                                        { title: "权重", dataIndex: "weight", width: 88 },
                                        { title: "超时", dataIndex: "timeout", width: 96, render: (value) => `${value || 600}s` },
                                        {
                                            title: "操作",
                                            key: "actions",
                                            width: 220,
                                            align: "right",
                                            render: (_, item) => (
                                                <Space size={4}>
                                                    <Button size="small" onClick={() => openTestDialog(item._index)}>
                                                        测试
                                                    </Button>
                                                    <Button size="small" onClick={() => openChannelDrawer(item._index)}>
                                                        编辑
                                                    </Button>
                                                    <Button
                                                        danger
                                                        size="small"
                                                        icon={<DeleteOutlined />}
                                                        onClick={() => {
                                                            const nextChannels = [...channels];
                                                            nextChannels.splice(item._index, 1);
                                                            void persistChannels(nextChannels);
                                                        }}
                                                    />
                                                </Space>
                                            ),
                                        },
                                    ]}
                                />
                            </Flex>
                        </Form>
                    ) : (
                        <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                            <CodeMirror
                                value={activeJsonText}
                                height="520px"
                                extensions={[json(), jsonEditorTheme]}
                                basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                theme="none"
                                onChange={(value) => setJsonText((current) => ({ ...current, private: value }))}
                                style={{ fontSize: 13 }}
                            />
                        </div>
                    )}
                </Card>
                <Drawer
                    title={editingChannelIndex === null ? "新增渠道" : "编辑渠道"}
                    open={isChannelDrawerOpen}
                    size={560}
                    onClose={closeChannelDrawer}
                    extra={
                        <Space>
                            <Button onClick={closeChannelDrawer}>取消</Button>
                            <Button type="primary" onClick={() => void saveChannel()}>
                                保存
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Form form={channelForm} layout="vertical" requiredMark={false} initialValues={emptyChannel}>
                        <Row gutter={16}>
                            <Col span={12}>
                                <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}>
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="protocol" label="协议">
                                    <Select
                                        options={[
                                            { label: "OpenAI", value: "openai" },
                                            { label: "Gemini", value: "gemini" },
                                            { label: "Grok2API", value: "grok2api" },
                                            { label: "MiniMax & METASO", value: "metaso" },
                                            { label: "APIMart", value: "apimart" },
                                            { label: "KIE", value: "kie" },
                                            { label: "MiMo", value: "mimo" },
                                        ]}
                                        onChange={(protocol: AdminModelChannel["protocol"]) => {
                                            channelForm.setFieldValue("baseUrl", modelChannelDefaultBaseUrls[protocol]);
                                        }}
                                    />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="weight" label="权重">
                                    <InputNumber min={1} step={1} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="timeout" label="请求超时（秒）" extra="用于后台代理请求、模型列表读取和渠道测试">
                                    <InputNumber min={1} step={30} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="enabled" label="启用" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item
                                    name="baseUrl"
                                    label={
                                        <span className="relative inline-flex items-center">
                                            接口地址
                                            {channelApiKeyUrl ? (
                                                <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap">
                                                    <Button type="primary" size="small" href={channelApiKeyUrl} target="_blank">
                                                        获取 API Key
                                                    </Button>
                                                </span>
                                            ) : null}
                                        </span>
                                    }
                                    rules={[{ required: true, message: "请输入接口地址" }]}
                                >
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="apiKey" label="API Key" rules={editingChannelIndex === null ? [{ required: true, message: "请输入 API Key" }] : []}>
                                    <Input.Password placeholder={editingChannelIndex === null ? "" : "留空则沿用已保存的 API Key"} />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item label="渠道可用模型">
                                    <Space.Compact style={{ width: "100%" }}>
                                        <Form.Item name="models" noStyle>
                                            <Select mode="tags" maxTagCount="responsive" tokenSeparators={[",", "\n"]} options={knownModels.map((model) => ({ label: model, value: model }))} />
                                        </Form.Item>
                                        <Button onClick={() => openChannelModelSelector()}>选择模型</Button>
                                    </Space.Compact>
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="remark" label="备注">
                                    <Input.TextArea rows={3} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Drawer>
                <Modal
                    title={
                        <Space size={12}>
                            选择渠道模型
                            <Typography.Text type="secondary">
                                已选择 {modelSelectSelected.length} / {uniqueModels([...modelSelectSource, ...modelSelectExisting]).length}
                            </Typography.Text>
                        </Space>
                    }
                    open={isModelSelectorOpen}
                    width={960}
                    onCancel={closeChannelModelSelector}
                    footer={
                        <Space>
                            <Button onClick={closeChannelModelSelector}>取消</Button>
                            <Button type="primary" onClick={confirmChannelModelSelector}>
                                确定
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={14}>
                        <Flex gap={12} wrap>
                            <Input.Search placeholder="搜索模型" allowClear value={modelSelectKeyword} onChange={(event) => setModelSelectKeyword(event.target.value)} style={{ flex: "1 1 260px" }} />
                            <Space.Compact style={{ flex: "1 1 320px" }}>
                                <Input value={modelSelectNewModel} placeholder="输入模型名称" onChange={(event) => setModelSelectNewModel(event.target.value)} onPressEnter={addModelInSelector} />
                                <Button onClick={addModelInSelector}>增加模型</Button>
                                <Button icon={<ReloadOutlined />} loading={isFetchingChannelModels} onClick={() => void fetchChannelModelList()}>
                                    拉取模型列表
                                </Button>
                            </Space.Compact>
                        </Flex>
                        <Tabs
                            activeKey={modelSelectTab}
                            onChange={(key) => setModelSelectTab(key as ModelSelectTabKey)}
                            items={[
                                { key: "new", label: `新获取的模型 (${modelSelectGroups.new.length})` },
                                { key: "current", label: `已有的模型 (${modelSelectGroups.current.length})` },
                            ]}
                        />
                        <Flex justify="space-between" align="center" gap={12} wrap>
                            <Typography.Text type="secondary">
                                当前列表已选择 {activeSelectedCount} / {activeModelSelectModels.length}
                            </Typography.Text>
                            <Space size={8}>
                                <Button size="small" disabled={!activeModelSelectModels.length || activeSelectedCount === activeModelSelectModels.length} onClick={selectActiveModels}>
                                    全选当前列表
                                </Button>
                                <Button size="small" disabled={!activeSelectedCount} onClick={clearActiveModels}>
                                    取消当前列表
                                </Button>
                            </Space>
                        </Flex>
                        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                            {activeModelSelectModels.length ? (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12 }}>
                                    {activeModelSelectModels.map((model) => (
                                        <Checkbox key={model} checked={modelSelectSelected.includes(model)} onChange={(event) => toggleSelectedModel(model, event.target.checked)}>
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
                <Modal
                    title={
                        <Space>
                            {testChannel?.name || "渠道"} 渠道的模型测试<Typography.Text type="secondary">共 {testChannel?.models.length || 0} 个模型</Typography.Text>
                        </Space>
                    }
                    open={testChannelIndex !== null}
                    width={920}
                    onCancel={closeTestDialog}
                    footer={
                        <Space>
                            <Button onClick={closeTestDialog}>取消</Button>
                            <Button type="primary" disabled={!selectedTestModels.length || testingModels.length > 0} onClick={() => void batchTestModels()}>
                                批量测试 {selectedTestModels.length} 个模型
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={12}>
                        <Typography.Text type="secondary">测试会向选中模型发送最小测试请求，用于确认渠道是否有响应。</Typography.Text>
                        <Input.Search placeholder="搜索模型..." allowClear value={testKeyword} onChange={(event) => setTestKeyword(event.target.value)} />
                        <Table
                            rowKey="model"
                            pagination={false}
                            scroll={{ y: 420 }}
                            dataSource={testModels.map((model) => ({ model }))}
                            rowSelection={{
                                selectedRowKeys: selectedTestModels,
                                onChange: (keys) => setSelectedTestModels(keys.map(String)),
                            }}
                            columns={[
                                { title: "模型名称", dataIndex: "model", render: (value) => <Typography.Text strong>{value}</Typography.Text> },
                                {
                                    title: "状态",
                                    dataIndex: "model",
                                    width: 260,
                                    render: (value) => {
                                        if (testingModels.includes(value)) return <Tag icon={<LoadingOutlined className="animate-spin" />}>测试中</Tag>;
                                        const result = testResults[value];
                                        if (!result) return <Tag>未开始</Tag>;
                                        return result.status === "success" ? (
                                            <Space size={6} wrap>
                                                <Tag color="success">成功</Tag>
                                                <Typography.Text type="secondary">请求时长: {result.duration}</Typography.Text>
                                                {result.message && result.message !== "ok" ? <Typography.Text type="secondary">{result.message}</Typography.Text> : null}
                                            </Space>
                                        ) : (
                                            <Typography.Text type="danger">{result.message}</Typography.Text>
                                        );
                                    },
                                },
                                {
                                    title: "操作",
                                    key: "actions",
                                    width: 120,
                                    align: "right",
                                    render: (_, item) => (
                                        <Button size="small" loading={testingModels.includes(item.model)} onClick={() => void testModelOnline(item.model)}>
                                            测试
                                        </Button>
                                    ),
                                },
                            ]}
                        />
                    </Flex>
                </Modal>
            </Flex>
        </main>
    );
}

function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    const privateSetting = normalizePrivateSetting(settings.private);
    return {
        public: {
            ...normalizePublicSetting(settings.public),
        },
        private: privateSetting,
    };
}

function normalizePublicSetting(setting: Partial<AdminSettings["public"]> = {}): AdminSettings["public"] {
    return {
        ...emptySettings.public,
        modelChannel: {
            ...emptySettings.public.modelChannel,
            ...(setting.modelChannel || {}),
            availableModels: setting.modelChannel?.availableModels || [],
            modelCosts: normalizeModelCosts(setting.modelChannel?.modelCosts || []),
            channels: setting.modelChannel?.channels || [],
            systemPrompts: {
                ...emptySettings.public.modelChannel.systemPrompts,
                image: setting.modelChannel?.systemPrompts?.image || setting.modelChannel?.systemPrompt || "",
                video: setting.modelChannel?.systemPrompts?.video || "",
                text: setting.modelChannel?.systemPrompts?.text || setting.modelChannel?.systemPrompt || "",
                workflow: setting.modelChannel?.systemPrompts?.workflow || "",
                workflowAgent: setting.modelChannel?.systemPrompts?.workflowAgent || "",
            },
        },
        auth: {
            allowRegister: setting.auth?.allowRegister !== false,
            linuxDo: {
                enabled: setting.auth?.linuxDo?.enabled === true,
            },
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
            allowUserProvider: setting.storage?.allowUserProvider === true,
        },
    };
}

function normalizeModelCosts(items: Partial<AdminSettings["public"]["modelChannel"]["modelCosts"][number]>[]) {
    return items.filter((item) => item.model).map((item) => ({ model: item.model || "", credits: Math.max(0, Number(item.credits) || 0) }));
}

function normalizePrivateSetting(setting: Partial<AdminSettings["private"]> = {}): AdminSettings["private"] {
    return {
        channels: (setting.channels || []).map(normalizeChannel),
        promptSync: {
            enabled: setting.promptSync?.enabled !== false,
            cron: setting.promptSync?.cron || "0 0 * * *",
        },
        aiLog: {
            localDirectReportEnabled: setting.aiLog?.localDirectReportEnabled === true,
            cleanup: {
                enabled: setting.aiLog?.cleanup?.enabled === true,
                retentionDays: Number(setting.aiLog?.cleanup?.retentionDays) || 14,
                cron: setting.aiLog?.cleanup?.cron || "0 3 * * *",
            },
        },
        auth: {
            linuxDo: {
                clientId: setting.auth?.linuxDo?.clientId || "",
                clientSecret: setting.auth?.linuxDo?.clientSecret || "",
            },
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
            allowUserProvider: setting.storage?.allowUserProvider === true,
            allowUserGlobalProvider: setting.storage?.allowUserGlobalProvider === true,
            providers: (setting.storage?.providers || []).map(normalizeStorageProvider),
            roundRobinCursor: Number(setting.storage?.roundRobinCursor) || 0,
            capacityCheck: {
                enabled: setting.storage?.capacityCheck?.enabled === true,
                cron: setting.storage?.capacityCheck?.cron || "0 */6 * * *",
            },
            capacityLimitBytes: Number(setting.storage?.capacityLimitBytes) || 9 * 1024 * 1024 * 1024,
            operationBudget: {
                enabled: setting.storage?.operationBudget?.enabled !== false,
                classALimit: Number(setting.storage?.operationBudget?.classALimit) || 1_000_000,
                classBLimit: Number(setting.storage?.operationBudget?.classBLimit) || 10_000_000,
                warningPercent: Number(setting.storage?.operationBudget?.warningPercent) || 80,
                stopPercent: Number(setting.storage?.operationBudget?.stopPercent) || 90,
            },
        },
    };
}

function normalizeStorageProvider(item: Partial<AdminStorageProvider> = {}): AdminStorageProvider {
    const type = item.type === "webdav" ? "webdav" : "s3";
    return {
        ...(type === "webdav" ? emptyWebDAVStorageProvider : emptyS3StorageProvider),
        ...item,
        id: item.id || "",
        type,
        region: type === "s3" ? item.region || "auto" : "",
        weight: Math.max(1, Number(item.weight) || 1),
        enabled: item.enabled !== false,
        capacityBytes: Number(item.capacityBytes) || 0,
        capacityCheckedAt: item.capacityCheckedAt || "",
        capacityExceeded: item.capacityExceeded === true,
    };
}

function newAdminStorageProvider(type: AdminStorageProvider["type"], providers: AdminStorageProvider[]) {
    const template = type === "webdav" ? emptyWebDAVStorageProvider : emptyS3StorageProvider;
    return {
        ...template,
        enabled: !providers.some((provider) => provider.enabled && provider.type !== type),
    };
}

function normalizeChannel(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    return {
        id: item.id || "",
        protocol: item.protocol || "openai",
        name: item.name || "",
        baseUrl: item.baseUrl || "",
        apiKey: item.apiKey || "",
        models: item.models || [],
        weight: Math.max(1, Number(item.weight) || 1),
        timeout: Math.max(1, Number(item.timeout) || 600),
        enabled: item.enabled !== false,
        remark: item.remark || "",
    };
}

function modelCostCredits(items: AdminSettings["public"]["modelChannel"]["modelCosts"], model: string) {
    return items.find((item) => item.model === model)?.credits || 0;
}

function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminSettings["public"]["modelChannel"]["modelCosts"];
    const next = current.filter((item) => item.model !== model);
    next.push({ model, credits: Math.max(0, credits) });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

function mergeChannelApiKeys(currentChannels: AdminModelChannel[], saved: AdminSettings): AdminSettings {
    const channels = saved.private.channels.map((item, index) => ({
        ...item,
        apiKey: currentChannels[index]?.apiKey || item.apiKey,
    }));
    return {
        public: saved.public,
        private: { ...saved.private, channels },
    };
}

function collectChannelModels(channels: AdminModelChannel[]) {
    return uniqueModels(channels.filter((channel) => channel.enabled).flatMap((channel) => channel.models || []));
}

function collectKnownModels(settings: AdminSettings) {
    return uniqueModels([...(settings.public.modelChannel.availableModels || []), ...(settings.public.modelChannel.modelCosts || []).map((item) => item.model), ...settings.private.channels.flatMap((channel) => channel.models || [])]);
}

function buildModelSelectGroups(sourceModels: string[], existingModels: string[]): Record<ModelSelectTabKey, string[]> {
    const source = uniqueModels(sourceModels);
    const existing = uniqueModels(existingModels);
    const existingSet = new Set(existing);
    return {
        new: source.filter((model) => !existingSet.has(model)),
        current: existing,
    };
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

function filterModels(models: string[], options: string[]) {
    const optionSet = new Set(options);
    return uniqueModels(models).filter((model) => optionSet.has(model));
}

function modelSummary(models: string[]) {
    if (!models.length) return "未配置模型";
    const preview = models.slice(0, 3).join(", ");
    return models.length > 3 ? `${models.length} 个模型：${preview}...` : preview;
}

function formatStorageBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function StorageBudgetDetails({ result }: { result?: StorageCapacityResult }) {
    if (!result) {
        return <Typography.Text type="secondary">点击“刷新预算明细”查看本月容量和操作次数。</Typography.Text>;
    }
    const metrics = [
        { label: "标准存储", used: result.bytes, limit: result.limitBytes, value: `${formatStorageBytes(result.bytes)} / ${formatStorageBytes(result.limitBytes)}` },
        { label: "A 类操作", used: result.classAOperations, limit: result.classALimit, value: `${result.classAOperations.toLocaleString()} / ${result.classALimit.toLocaleString()}` },
        { label: "B 类操作", used: result.classBOperations, limit: result.classBLimit, value: `${result.classBOperations.toLocaleString()} / ${result.classBLimit.toLocaleString()}` },
    ];
    return (
        <Card size="small" title={<Space><span>{result.period} 预算明细</span><Tag>本机估算</Tag>{result.writeProtected && <Tag color="warning">写入保护中</Tag>}</Space>}>
            <Row gutter={[16, 12]}>
                {metrics.map((metric) => {
                    const percent = metric.limit > 0 ? Math.min(100, Math.round(metric.used / metric.limit * 100)) : 0;
                    const status = percent >= result.stopPercent ? "exception" : "normal";
                    return (
                        <Col xs={24} md={8} key={metric.label}>
                            <Flex justify="space-between" gap={8}>
                                <Typography.Text>{metric.label}</Typography.Text>
                                <Typography.Text type="secondary">{metric.value}</Typography.Text>
                            </Flex>
                            <Progress percent={percent} status={status} size="small" />
                            {percent >= result.warningPercent && percent < result.stopPercent && <Typography.Text type="warning">已达到预警线 {result.warningPercent}%</Typography.Text>}
                        </Col>
                    );
                })}
            </Row>
        </Card>
    );
}

function parseTabJson(tab: "public", value: string): AdminSettings["public"] | null;
function parseTabJson(tab: "private", value: string): AdminSettings["private"] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null {
    try {
        return tab === "public" ? normalizePublicSetting(JSON.parse(value) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(JSON.parse(value) as Partial<AdminSettings["private"]>);
    } catch {
        return null;
    }
}

async function collectSettings(form: any, editorMode: Record<SettingsTabKey, EditorMode>, jsonText: Record<SettingsTabKey, string>, message: { error: (value: string) => void }) {
    const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
    if (editorMode.public === "json") {
        const publicSetting = parseTabJson("public", jsonText.public);
        if (!publicSetting) {
            message.error("公开配置 JSON 格式不正确");
            return null;
        }
        values.public = publicSetting;
    }
    if (editorMode.private === "json") {
        const privateSetting = parseTabJson("private", jsonText.private);
        if (!privateSetting) {
            message.error("私有配置 JSON 格式不正确");
            return null;
        }
        values.private = privateSetting;
    }
    values.public.modelChannel.availableModels = filterModels(values.public.modelChannel.availableModels, collectChannelModels(values.private.channels));
    values.public.modelChannel.systemPrompt = values.public.modelChannel.systemPrompts.image || values.public.modelChannel.systemPrompts.text || "";
    return normalizeSettings(values);
}

function getJsonError(value: string) {
    try {
        JSON.parse(value);
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : "JSON 格式不正确";
    }
}
