"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { App, Alert, Button, Checkbox, Drawer, Dropdown, Form, Input, InputNumber, Modal, Select, Switch, Table, Tabs, Tag, Tooltip } from "antd";
import type { MenuProps, TableProps } from "antd";
import { ArrowRight, Cable, Copy, Ellipsis, Import, KeyRound, LogIn, Play, Plus, RefreshCw, Server, Square, TerminalSquare } from "lucide-react";

import { ProviderListState, ProviderStatusTag, ProviderSummary } from "@/app/(user)/providers/components/provider-list-state";
import { isRunningHubReference, type CLIHelperResult, type Provider, type ProviderCapability, type ProviderInput, type ProviderKind, type ProviderMigrationPreview, type ProviderProtocol, type ProviderStatus } from "@/lib/provider";
import { fetchProviderMigrationPreview } from "@/services/api/providers";
import { useConfigStore } from "@/stores/use-config-store";
import { useProviderStore } from "@/stores/use-provider-store";
import { useUserStore } from "@/stores/use-user-store";

type ProviderForm = {
    kind: ProviderKind;
    protocol: ProviderProtocol;
    name: string;
    baseUrl: string;
    apiKey: string;
    headersJson?: string;
    capabilities: ProviderCapability[];
    models: string[];
    defaultModel: string;
    timeout: number;
    enabled: boolean;
    isDefault: boolean;
    executable: string;
    workingDirectory: string;
};

type CLIProbeState = {
    providerId: string;
    providerName: string;
    result: CLIHelperResult;
};

const apiProtocolOptions = [
    ["OpenAI 兼容", "openai"],
    ["Gemini", "gemini"],
    ["通用 HTTP", "http"],
    ["Grok2API", "grok2api"],
    ["MetaSo / MiniMax", "metaso"],
    ["APIMart", "apimart"],
    ["KIE", "kie"],
    ["MiMo", "mimo"],
    ["RunningHub", "runninghub"],
    ["火山方舟", "volcengine"],
].map(([label, value]) => ({ label, value }));

const cliProtocolOptions = [
    { label: "Codex CLI", value: "codex" },
    { label: "Gemini CLI", value: "gemini-cli" },
    { label: "即梦 CLI", value: "jimeng" },
];

const capabilityOptions = [
    { label: "文本", value: "text" },
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const probeStatusMeta = {
    running: { label: "运行中", color: "processing" },
    succeeded: { label: "已成功", color: "success" },
    failed: { label: "失败", color: "error" },
    cancelled: { label: "已取消", color: "default" },
    timed_out: { label: "已超时", color: "warning" },
} as const;

const initialForm: ProviderForm = {
    kind: "api",
    protocol: "openai",
    name: "",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    headersJson: "",
    capabilities: ["text", "image"],
    models: [],
    defaultModel: "",
    timeout: 120,
    enabled: true,
    isDefault: false,
    executable: "",
    workingDirectory: "",
};

export default function ProvidersPage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const items = useProviderStore((state) => state.items);
    const loading = useProviderStore((state) => state.loading);
    const error = useProviderStore((state) => state.error);
    const load = useProviderStore((state) => state.load);
    const save = useProviderStore((state) => state.save);
    const remove = useProviderStore((state) => state.remove);
    const markDefault = useProviderStore((state) => state.setDefault);
    const test = useProviderStore((state) => state.test);
    const detectCLI = useProviderStore((state) => state.detectCLI);
    const checkCLIAuth = useProviderStore((state) => state.checkCLIAuth);
    const startCLILogin = useProviderStore((state) => state.startCLILogin);
    const startCLIProbe = useProviderStore((state) => state.startCLIProbe);
    const queryCLIProbe = useProviderStore((state) => state.queryCLIProbe);
    const cancelCLIProbe = useProviderStore((state) => state.cancelCLIProbe);
    const migrate = useProviderStore((state) => state.migrate);
    const [activeKind, setActiveKind] = useState<ProviderKind>("api");
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editing, setEditing] = useState<Provider | null>(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [checkingAuth, setCheckingAuth] = useState(false);
    const [startingLogin, setStartingLogin] = useState(false);
    const [startingProbe, setStartingProbe] = useState(false);
    const [cancellingProbe, setCancellingProbe] = useState(false);
    const [probeOpen, setProbeOpen] = useState(false);
    const [probe, setProbe] = useState<CLIProbeState | null>(null);
    const [migrationOpen, setMigrationOpen] = useState(false);
    const [migrationPreview, setMigrationPreview] = useState<ProviderMigrationPreview | null>(null);
    const [cleanupLegacy, setCleanupLegacy] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const probeProviderId = probe?.providerId;
    const probeTaskId = probe?.result.taskId;
    const probeTaskStatus = probe?.result.taskStatus;
    const [form] = Form.useForm<ProviderForm>();
    const formKind = Form.useWatch("kind", form) || activeKind;
    const formProtocol = Form.useWatch("protocol", form) || (formKind === "api" ? "openai" : "codex");
    const models = Form.useWatch("models", form) || [];

    useEffect(() => {
        if (token) void load(token).catch(() => undefined);
    }, [load, token]);

    useEffect(() => {
        if (!token) return;
        void fetchProviderMigrationPreview(token)
            .then(setMigrationPreview)
            .catch(() => undefined);
    }, [token]);

    useEffect(() => {
        if (!token || !probeOpen || !probeProviderId || !probeTaskId || probeTaskStatus !== "running") return;
        let active = true;
        let timer: number | undefined;
        const poll = () => {
            timer = window.setTimeout(() => {
                void queryCLIProbe(token, probeProviderId, probeTaskId)
                    .then((result) => setProbe((current) => (current?.result.taskId === probeTaskId ? { ...current, result } : current)))
                    .catch((queryError) =>
                        setProbe((current) =>
                            current?.result.taskId === probeTaskId
                                ? { ...current, result: { ...current.result, message: queryError instanceof Error ? queryError.message : "调用状态读取失败" } }
                                : current,
                        ),
                    )
                    .finally(() => {
                        if (active) poll();
                    });
            }, 5000);
        };
        poll();
        return () => {
            active = false;
            if (timer) window.clearTimeout(timer);
        };
    }, [probeOpen, probeProviderId, probeTaskId, probeTaskStatus, queryCLIProbe, token]);

    const visibleItems = useMemo(() => items.filter((item) => item.kind === activeKind), [activeKind, items]);
    const connectedCount = visibleItems.filter((item) => item.connectionStatus === "connected").length;
    const countsPending = (loading || Boolean(error)) && !items.length;

    function openCreate(kind = activeKind) {
        setEditing(null);
        form.setFieldsValue({
            ...initialForm,
            kind,
            protocol: kind === "api" ? "openai" : "codex",
            capabilities: kind === "api" ? ["text", "image"] : ["text"],
        });
        setDrawerOpen(true);
    }

    function openEdit(item: Provider, duplicate = false) {
        setEditing(duplicate ? null : item);
        form.setFieldsValue({
            kind: item.kind,
            protocol: item.protocol,
            name: duplicate ? `${item.name} 副本` : item.name,
            baseUrl: item.baseUrl,
            apiKey: "",
            headersJson: "",
            capabilities: item.capabilities,
            models: item.models,
            defaultModel: item.defaultModel,
            timeout: item.timeout,
            enabled: item.enabled,
            isDefault: duplicate ? false : item.isDefault,
            executable: item.executable,
            workingDirectory: item.workingDirectory,
        });
        setDrawerOpen(true);
    }

    async function submit(values: ProviderForm) {
        if (!token) return;
        setSaving(true);
        try {
            const headersText = values.headersJson?.trim() || "";
            const input: ProviderInput = {
                id: editing?.id,
                kind: values.kind,
                protocol: values.protocol,
                name: values.name,
                baseUrl: values.kind === "api" ? values.baseUrl : undefined,
                apiKey: values.apiKey || undefined,
                headers: headersText ? (JSON.parse(headersText) as Record<string, string>) : undefined,
                capabilities: values.capabilities,
                models: values.models,
                defaultModel: values.defaultModel,
                timeout: values.timeout,
                enabled: values.enabled,
                isDefault: values.isDefault,
                executable: values.executable,
                workingDirectory: values.workingDirectory,
            };
            await save(token, input);
            message.success(editing ? "连接已更新" : "连接已创建");
            setDrawerOpen(false);
        } catch (saveError) {
            message.error(saveError instanceof Error ? saveError.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    async function runTest(refreshModels = false) {
        if (!token || !editing) return;
        setTesting(true);
        try {
            if (editing.kind === "cli") {
                const result = await detectCLI(token, editing.id);
                message.success(result.message);
            } else {
                await test(token, editing.id, refreshModels);
                message.success(refreshModels && editing.protocol !== "runninghub" ? "连接成功，模型列表已刷新" : "连接成功");
            }
            const testedItem = useProviderStore.getState().items.find((item) => item.id === editing.id) || editing;
            setEditing(testedItem);
            if (refreshModels && testedItem.kind === "api" && testedItem.protocol !== "runninghub") {
                form.setFieldsValue({ models: testedItem.models, defaultModel: testedItem.defaultModel });
            }
        } catch (testError) {
            message.error(testError instanceof Error ? testError.message : "连接测试失败");
        } finally {
            setTesting(false);
        }
    }

    async function checkLoginStatus() {
        if (!token || !editing || editing.protocol !== "codex") return;
        setCheckingAuth(true);
        try {
            const result = await checkCLIAuth(token, editing.id);
            if (result.authStatus === "authenticated") message.success(result.message);
            else if (result.authStatus === "unauthenticated") message.warning(result.message);
            else message.info(result.message);
        } catch (authError) {
            message.error(authError instanceof Error ? authError.message : "登录状态检测失败");
        } finally {
            setCheckingAuth(false);
        }
    }

    function confirmCLILogin() {
        if (!token || !editing || editing.protocol !== "codex" || startingLogin) return;
        setStartingLogin(true);
        modal.confirm({
            title: "打开 Codex 登录？",
            content: (
                <div className="space-y-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                    <p>伴随进程将执行固定的 codex login，并打开系统浏览器完成 ChatGPT OAuth。</p>
                    <p>登录最长等待 10 分钟。系统不会接收 API Key、Token 或自定义参数，也不会保存或回传命令输出。</p>
                </div>
            ),
            okText: "打开浏览器登录",
            cancelText: "取消",
            onCancel: () => setStartingLogin(false),
            async onOk() {
                try {
                    const result = await startCLILogin(token, editing.id);
                    if (result.actionStatus === "started") message.success(result.message);
                    else message.info(result.message);
                } catch (loginError) {
                    message.error(loginError instanceof Error ? loginError.message : "Codex 登录启动失败");
                    throw loginError;
                } finally {
                    setStartingLogin(false);
                }
            },
        });
    }

    function confirmCLIModelProbe() {
        if (!token || !editing || editing.protocol !== "codex" || startingProbe) return;
        const providerId = editing.id;
        const providerName = editing.name;
        setStartingProbe(true);
        modal.confirm({
            title: "确认执行 Codex 最小调用？",
            width: 560,
            content: (
                <div className="space-y-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                    <div className="grid grid-cols-[88px_1fr] gap-x-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <span>调用渠道</span>
                        <span className="font-medium text-stone-950 dark:text-stone-100">{providerName}</span>
                        <span>模型</span>
                        <span className="font-medium text-stone-950 dark:text-stone-100">Codex CLI 当前默认模型</span>
                        <span>任务类型</span>
                        <span className="font-medium text-stone-950 dark:text-stone-100">固定最小文本验证</span>
                        <span>固定提示词</span>
                        <code className="break-all text-xs">Reply with exactly OK. Do not inspect files, run commands, or use tools.</code>
                    </div>
                    <p>伴随进程只会在临时目录和只读沙箱中执行一次非交互调用，最长 2 分钟，最终输出最多读取 4 KiB；不会接收自定义提示词、参数或工作目录。</p>
                    <Alert type="warning" showIcon title="此操作可能产生少量模型调用费用，不会自动重试。" />
                </div>
            ),
            okText: "确认调用",
            cancelText: "取消",
            onCancel: () => setStartingProbe(false),
            async onOk() {
                try {
                    const result = await startCLIProbe(token, providerId);
                    if (!result.taskId || !result.taskStatus) {
                        message.warning(result.message);
                        return;
                    }
                    setProbe({ providerId, providerName, result });
                    setProbeOpen(true);
                } catch (probeError) {
                    message.error(probeError instanceof Error ? probeError.message : "Codex 最小调用启动失败");
                    throw probeError;
                } finally {
                    setStartingProbe(false);
                }
            },
        });
    }

    async function cancelCurrentCLIModelProbe() {
        const taskId = probe?.result.taskId;
        if (!token || !probe || !taskId || probe.result.taskStatus !== "running" || cancellingProbe) return;
        setCancellingProbe(true);
        try {
            const result = await cancelCLIProbe(token, probe.providerId, taskId);
            setProbe((current) => (current?.result.taskId === taskId ? { ...current, result } : current));
            message.success(result.message);
        } catch (cancelError) {
            message.error(cancelError instanceof Error ? cancelError.message : "取消调用失败");
        } finally {
            setCancellingProbe(false);
        }
    }

    async function toggleProvider(item: Provider, enabled: boolean) {
        if (!token) return;
        try {
            await save(token, { ...providerToInput(item), enabled });
            message.success(enabled ? "渠道已启用" : "渠道已禁用");
        } catch (toggleError) {
            message.error(toggleError instanceof Error ? toggleError.message : "状态更新失败");
        }
    }

    function confirmToggleProvider(item: Provider, enabled: boolean) {
        if (enabled) {
            void toggleProvider(item, true);
            return;
        }
        modal.confirm({
            title: `停用「${item.name}」？`,
            content: "停用后，画布与创作台将不再选择此连接。连接配置和已加密凭据会保留，可随时重新启用。",
            okText: "确认停用",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => toggleProvider(item, false),
        });
    }

    function confirmDelete(item: Provider) {
        modal.confirm({
            title: `删除「${item.name}」？`,
            content: "如果历史任务仍引用该渠道，系统会拒绝删除并建议改为禁用。密钥删除后无法恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            async onOk() {
                if (!token) return;
                try {
                    await remove(token, item.id);
                    message.success("连接已删除");
                } catch (deleteError) {
                    message.error(deleteError instanceof Error ? deleteError.message : "删除失败");
                    throw deleteError;
                }
            },
        });
    }

    async function setAsDefault(item: Provider) {
        if (!token) return;
        try {
            await markDefault(token, item.id);
            message.success("已设为默认连接");
        } catch (defaultError) {
            message.error(defaultError instanceof Error ? defaultError.message : "设置失败");
        }
    }

    async function runMigration() {
        if (!token) return;
        setMigrating(true);
        try {
            const result = await migrate(token, cleanupLegacy);
            if (cleanupLegacy) applyCleanedMigrationToConfig(result.mappings);
            const nextPreview = await fetchProviderMigrationPreview(token);
            setMigrationPreview(nextPreview);
            setMigrationOpen(false);
            message.success(`已导入 ${result.importedCount} 个、复用 ${result.reusedCount} 个连接${cleanupLegacy ? `，清理 ${result.cleanedSecrets} 处旧密钥` : ""}`);
        } catch (migrationError) {
            message.error(migrationError instanceof Error ? migrationError.message : "迁移失败");
        } finally {
            setMigrating(false);
        }
    }

    const columns: TableProps<Provider>["columns"] = [
        {
            title: "连接",
            dataIndex: "name",
            render: (_, item) => (
                <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium text-stone-950 dark:text-stone-100">
                        <span className="truncate">{item.name}</span>
                        {item.isDefault ? <Tag color="blue">默认</Tag> : null}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span className="uppercase">{item.protocol}</span>
                        {item.hasApiKey ? (
                            <span className="inline-flex items-center gap-1">
                                <KeyRound className="size-3" />
                                密钥已保存
                            </span>
                        ) : null}
                    </div>
                </div>
            ),
        },
        {
            title: "能力",
            dataIndex: "capabilities",
            render: (values: ProviderCapability[]) => (
                <div className="flex flex-wrap gap-1">
                    {values.map((value) => (
                        <Tag key={value}>{capabilityOptions.find((item) => item.value === value)?.label || value}</Tag>
                    ))}
                </div>
            ),
        },
        { title: "默认模型", dataIndex: "defaultModel", ellipsis: true, render: (value: string) => value || <span className="text-stone-400">未设置</span> },
        { title: "状态", dataIndex: "connectionStatus", render: (value: ProviderStatus, item) => <ProviderStatusTag status={testing && editing?.id === item.id ? "testing" : value} message={testing && editing?.id === item.id ? "正在检测连接，请稍候" : item.statusMessage} /> },
        { title: "启用", dataIndex: "enabled", width: 76, render: (enabled: boolean, item) => <Switch size="small" checked={enabled} onChange={(checked) => confirmToggleProvider(item, checked)} /> },
        { title: "", key: "actions", width: 48, render: (_, item) => <ProviderActions item={item} onEdit={() => openEdit(item)} onCopy={() => openEdit(item, true)} onDefault={() => void setAsDefault(item)} onDelete={() => confirmDelete(item)} /> },
    ];

    return (
        <main className="h-full overflow-y-auto bg-stone-50/50 dark:bg-stone-950/20">
            <div className="mx-auto w-full max-w-7xl px-5 py-7 md:px-8 md:py-9">
                <div className="flex flex-col gap-5 border-b border-stone-200 pb-5 md:flex-row md:items-end md:justify-between dark:border-stone-800">
                    <div>
                        <div className="mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-stone-500 dark:text-stone-400">
                            <Cable className="size-3.5" />
                            连接调度台
                        </div>
                        <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">连接中心</h1>
                        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-stone-600 dark:text-stone-400">统一管理创作链路使用的 API 与本机 CLI。密钥只在后端加密保存，页面不会读取明文。</p>
                    </div>
                    <Button className="w-full md:w-auto" type="primary" icon={<Plus className="size-4" />} onClick={() => openCreate()}>
                        新增{activeKind === "api" ? " API" : " CLI"}
                    </Button>
                </div>

                <ProviderSummary count={visibleItems.length} connectedCount={connectedCount} pending={countsPending} />

                <Tabs
                    className="mt-2"
                    activeKey={activeKind}
                    onChange={(key) => setActiveKind(key as ProviderKind)}
                    items={[
                        {
                            key: "api",
                            label: (
                                <span className="inline-flex items-center gap-2">
                                    <Server className="size-4" />
                                    API 渠道
                                </span>
                            ),
                        },
                        {
                            key: "cli",
                            label: (
                                <span className="inline-flex items-center gap-2">
                                    <TerminalSquare className="size-4" />
                                    CLI 渠道
                                </span>
                            ),
                        },
                    ]}
                />

                {activeKind === "api" && migrationPreview?.total ? (
                    <Alert
                        className="mb-4"
                        type="warning"
                        showIcon
                        title={`发现 ${migrationPreview.total} 个旧版本地渠道`}
                        description={`${migrationPreview.importable} 个可新建，${migrationPreview.reusable} 个可复用已有连接，${migrationPreview.invalid} 个需要手动修正。迁移不会自动测试连接。`}
                        action={
                            <Button size="small" icon={<Import className="size-3.5" />} onClick={() => setMigrationOpen(true)}>
                                预览迁移
                            </Button>
                        }
                    />
                ) : null}

                {activeKind === "cli" ? <Alert className="mb-4" type="info" showIcon title="受控 Mac CLI helper" description="仅在本机回环地址且显式启用时执行固定版本检测；Codex 登录和最小调用都需要逐次确认，不接受用户填写的命令、参数、提示词或执行路径。" /> : null}
                {error && visibleItems.length ? (
                    <Alert
                        className="mb-4"
                        type="error"
                        showIcon
                        title="连接列表读取失败"
                        description={error}
                        action={
                            <Button size="small" onClick={() => token && void load(token, true)}>
                                重试
                            </Button>
                        }
                    />
                ) : null}

                {!visibleItems.length ? (
                    <ProviderListState kind={activeKind} loading={loading} error={error} onCreate={() => openCreate()} onRetry={() => token && void load(token, true)} />
                ) : (
                    <section className="overflow-hidden rounded-lg lg:border lg:border-stone-200 lg:bg-background dark:lg:border-stone-800" aria-busy={loading}>
                        <div className="hidden lg:block">
                            <Table size="middle" rowKey="id" columns={columns} dataSource={visibleItems} pagination={false} scroll={{ x: 880 }} />
                        </div>
                        <div className="space-y-3 lg:hidden">
                            {visibleItems.map((item) => (
                                <ProviderCard
                                    key={item.id}
                                    item={item}
                                    testing={testing && editing?.id === item.id}
                                    onEdit={() => openEdit(item)}
                                    onToggle={(checked) => confirmToggleProvider(item, checked)}
                                    actions={<ProviderActions item={item} onEdit={() => openEdit(item)} onCopy={() => openEdit(item, true)} onDefault={() => void setAsDefault(item)} onDelete={() => confirmDelete(item)} />}
                                />
                            ))}
                        </div>
                    </section>
                )}
            </div>

            <Drawer
                title={editing ? "编辑连接" : "新增连接"}
                size="min(440px, 100vw)"
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                footer={
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                            {editing?.kind === "api" ? (
                                <Button icon={<RefreshCw className="size-4" />} loading={testing} onClick={() => void runTest(formKind === "api")}>
                                    {formProtocol === "runninghub" ? "检测 OpenAPI" : "测试并拉取模型"}
                                </Button>
                            ) : null}
                        </div>
                        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                            <Button className="w-full" onClick={() => setDrawerOpen(false)}>取消</Button>
                            <Button className="w-full" type="primary" loading={saving} onClick={() => form.submit()}>
                                保存
                            </Button>
                        </div>
                    </div>
                }
            >
                <Form form={form} layout="vertical" initialValues={initialForm} onFinish={(values) => void submit(values)} requiredMark="optional" scrollToFirstError={{ block: "center" }}>
                    <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                        <Form.Item name="kind" label="连接类型" rules={[{ required: true, message: "请选择连接类型" }]}>
                            <Select
                                disabled={Boolean(editing)}
                                options={[
                                    { label: "API 渠道", value: "api" },
                                    { label: "CLI 渠道", value: "cli" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item name="protocol" label={formKind === "api" ? "协议类型" : "CLI 类型"} rules={[{ required: true, message: `请选择${formKind === "api" ? "协议" : " CLI 类型"}` }]}>
                            <Select
                                options={formKind === "api" ? apiProtocolOptions : cliProtocolOptions}
                                onChange={(protocol: ProviderProtocol) => {
                                    if (protocol === "runninghub") {
                                        form.setFieldsValue({ baseUrl: "https://www.runninghub.ai", capabilities: ["image", "video", "audio", "text"], models: [], defaultModel: "" });
                                    } else if (protocol === "http") {
                                        form.setFieldsValue({ baseUrl: "", capabilities: ["text"], models: [], defaultModel: "" });
                                    }
                                }}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item name="name" label="连接名称" rules={[{ required: true, message: "请输入连接名称" }, { max: 80, message: "连接名称不能超过 80 个字符" }]}>
                        <Input placeholder="例如：主力生图 API" />
                    </Form.Item>

                    {formKind === "api" ? (
                        <>
                            <Form.Item
                                name="baseUrl"
                                label="Base URL"
                                rules={[
                                    { required: true, message: "请输入 Base URL" },
                                    { type: "url", message: "请输入有效的 HTTP 或 HTTPS 地址" },
                                ]}
                            >
                                <Input placeholder="https://api.example.com" />
                            </Form.Item>
                            <Form.Item label="API Key" extra={editing?.hasApiKey ? "密钥已保存。留空保持不变；页面不会读取原密钥。" : "密钥将由后端加密保存。"} name="apiKey">
                                <Input.Password autoComplete="new-password" placeholder={editing?.hasApiKey ? "已保存 ••••••••" : "输入 API Key"} />
                            </Form.Item>
                            <Form.Item
                                name="headersJson"
                                label="自定义请求头"
                                extra={editing?.hasHeaders ? `已保存：${editing.headerNames.join("、")}。留空保持不变。` : "可选，值会与 API Key 一起加密。"}
                                rules={[
                                    {
                                        validator: async (_, value) => {
                                            if (!value?.trim()) return;
                                            try {
                                                const parsed = JSON.parse(value);
                                                if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
                                            } catch {
                                                throw new Error("请输入有效的 JSON 对象");
                                            }
                                        },
                                    },
                                ]}
                            >
                                <Input.TextArea rows={3} placeholder={'{\n  "X-Project-ID": "..."\n}'} />
                            </Form.Item>
                            <Form.Item name="capabilities" label="能力">
                                <Checkbox.Group options={capabilityOptions} />
                            </Form.Item>
                            {formProtocol === "runninghub" ? (
                                <Alert
                                    className="mb-5"
                                    type="info"
                                    showIcon
                                    title="RunningHub 应用 / 工作流 adapter"
                                    description="引用格式为 app:<ID> 或 workflow:<ID>。连接检测只读取账户状态；任务提交与查询使用独立受控接口，不会伪装成 OpenAI 模型协议。"
                                />
                            ) : formProtocol === "http" ? (
                                <Alert
                                    className="mb-5"
                                    type="info"
                                    showIcon
                                    title="通用 HTTP adapter"
                                    description="Base URL 按原样使用，系统直接追加 /models、/chat/completions、/images/generations 或 /videos 等业务路径；鉴权可使用 API Key 或自定义请求头。"
                                />
                            ) : null}
                        </>
                    ) : (
                        <>
                            <Alert
                                className="mb-5"
                                type="info"
                                showIcon
                                title={formProtocol === "codex" ? "Codex 登录状态可只读检测" : "当前仅检测 CLI 安装与版本"}
                                description={formProtocol === "codex" ? "保存后可逐次授权检查状态；登录和最小模型调用均需二次确认。最小调用使用固定提示词、只读沙箱和当前默认模型，不接受 API Key、Token 或自定义参数。" : "Gemini 与即梦尚无已确认的非交互登录状态命令，系统不会猜测或执行交互式登录。"}
                            />
                            {editing?.kind === "cli" && editing.protocol === formProtocol ? (
                                <div className="mb-5 rounded-lg border border-stone-200 bg-stone-50/60 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                                    <div className="font-medium text-stone-950 dark:text-stone-100">受控本机操作</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">每项操作都使用固定参数并单独授权，不会读取或执行页面填写的命令。</div>
                                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                        <Button icon={<RefreshCw className="size-4" />} loading={testing} onClick={() => void runTest(false)}>
                                            检测 CLI
                                        </Button>
                                        {formProtocol === "codex" ? (
                                            <>
                                                <Button icon={<KeyRound className="size-4" />} loading={checkingAuth} onClick={() => void checkLoginStatus()}>
                                                    检查登录状态
                                                </Button>
                                                <Button type="primary" icon={<LogIn className="size-4" />} loading={startingLogin} onClick={confirmCLILogin}>
                                                    登录 Codex
                                                </Button>
                                                <Button icon={<Play className="size-4" />} loading={startingProbe} onClick={confirmCLIModelProbe}>
                                                    最小调用
                                                </Button>
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                            ) : null}
                            <Form.Item name="executable" label="检测到的可执行程序" extra="该字段由受控 helper 写入；页面输入不会决定执行目标。">
                                <Input readOnly placeholder="保存后点击“检测 CLI”" />
                            </Form.Item>
                            <Form.Item name="workingDirectory" label="默认工作目录" rules={[{ pattern: /^\//, message: "请输入以 / 开头的绝对路径" }]}>
                                <Input placeholder="例如 /Users/name/projects" />
                            </Form.Item>
                        </>
                    )}

                    <Form.Item
                        name="models"
                        label={formProtocol === "runninghub" ? "应用 / 工作流引用" : "模型列表"}
                        rules={
                            formProtocol === "runninghub"
                                ? [
                                      {
                                          validator: async (_, values: string[]) => {
                                              if ((values || []).every(isRunningHubReference)) return;
                                              throw new Error("请使用 app:<ID> 或 workflow:<ID>");
                                          },
                                      },
                                  ]
                                : undefined
                        }
                    >
                        <Select mode="tags" tokenSeparators={[","]} placeholder={formProtocol === "runninghub" ? "例如 workflow:2058824859437850625" : "输入模型名后回车"} />
                    </Form.Item>
                    <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                        <Form.Item name="defaultModel" label="默认模型">
                            <Select allowClear showSearch options={models.map((model) => ({ label: model, value: model }))} placeholder="选择默认模型" />
                        </Form.Item>
                        <Form.Item name="timeout" label="请求超时（秒）">
                            <InputNumber className="w-full" min={1} max={600} />
                        </Form.Item>
                    </div>
                    <div className="grid grid-cols-1 gap-4 rounded-lg border border-stone-200 p-4 sm:grid-cols-2 dark:border-stone-800">
                        <Form.Item name="enabled" valuePropName="checked" label="启用连接" extra="停用后工作区不再选择此连接" className="mb-0">
                            <Switch />
                        </Form.Item>
                        <Form.Item name="isDefault" valuePropName="checked" label="设为默认" extra="仅对已启用连接生效" className="mb-0">
                            <Switch />
                        </Form.Item>
                    </div>
                </Form>
            </Drawer>
            <Modal
                title="Codex 最小调用"
                width={560}
                open={probeOpen}
                closable={probe?.result.taskStatus !== "running"}
                keyboard={probe?.result.taskStatus !== "running"}
                mask={{ closable: probe?.result.taskStatus !== "running" }}
                onCancel={() => probe?.result.taskStatus !== "running" && setProbeOpen(false)}
                footer={
                    probe?.result.taskStatus === "running"
                        ? [
                              <Button key="cancel" danger icon={<Square className="size-3.5" />} loading={cancellingProbe} onClick={() => void cancelCurrentCLIModelProbe()}>
                                  取消调用
                              </Button>,
                          ]
                        : [
                              <Button key="close" type="primary" onClick={() => setProbeOpen(false)}>
                                  关闭
                              </Button>,
                          ]
                }
            >
                {probe ? (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                            <div>
                                <div className="font-medium text-stone-950 dark:text-stone-100">{probe.providerName}</div>
                                <div className="mt-1 text-xs text-stone-500">Codex CLI 当前默认模型 · 固定最小文本验证</div>
                            </div>
                            {probe.result.taskStatus ? <Tag color={probeStatusMeta[probe.result.taskStatus].color}>{probeStatusMeta[probe.result.taskStatus].label}</Tag> : null}
                        </div>
                        <Alert type={probe.result.taskStatus === "failed" || probe.result.taskStatus === "timed_out" ? "error" : probe.result.taskStatus === "succeeded" ? "success" : "info"} showIcon title={probe.result.message} />
                        {probe.result.output ? (
                            <div>
                                <div className="mb-2 text-xs font-medium text-stone-500">最终输出（最多 4 KiB）</div>
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-stone-100 p-3 text-xs text-stone-900 dark:bg-stone-900 dark:text-stone-100">{probe.result.output}</pre>
                            </div>
                        ) : null}
                        <p className="text-xs leading-5 text-stone-500">任务运行期间必须先点击“取消调用”才能关闭窗口；关闭完成状态不会再次调用模型。</p>
                    </div>
                ) : null}
            </Modal>
            <Modal
                title="迁移旧版渠道"
                width={720}
                open={migrationOpen}
                okText="确认迁移"
                cancelText="取消"
                confirmLoading={migrating}
                okButtonProps={{ disabled: !migrationPreview || migrationPreview.importable + migrationPreview.reusable === 0 }}
                onOk={() => void runMigration()}
                onCancel={() => setMigrationOpen(false)}
            >
                <p className="mb-4 text-sm leading-6 text-stone-600 dark:text-stone-400">默认只把旧渠道复制到连接中心并加密保存，旧配置保持不变。全程不会请求渠道接口，也不会在结果中返回密钥。</p>
                <div className="max-h-[360px] overflow-auto rounded-lg border border-stone-200 dark:border-stone-800">
                    <Table
                        size="small"
                        rowKey={(item) => `${item.sourceId}-${item.name}`}
                        dataSource={migrationPreview?.items || []}
                        pagination={false}
                        scroll={{ x: 620 }}
                        columns={[
                            {
                                title: "旧渠道",
                                render: (_, item) => (
                                    <div className="min-w-0">
                                        <div className="font-medium text-stone-950 dark:text-stone-100">{item.name}</div>
                                        <div className="mt-0.5 max-w-[280px] truncate text-xs text-stone-500">{item.baseUrl || "未配置地址"}</div>
                                    </div>
                                ),
                            },
                            { title: "协议", dataIndex: "protocol", width: 110, render: (value: string) => <span className="uppercase">{value}</span> },
                            { title: "模型", dataIndex: "models", width: 80, render: (values: string[]) => values.length },
                            {
                                title: "处理",
                                width: 150,
                                render: (_, item) => (
                                    <Tooltip title={item.issue}>
                                        <Tag color={item.action === "import" ? "blue" : item.action === "reuse" ? "success" : "error"}>{item.action === "import" ? "新建连接" : item.action === "reuse" ? "复用并去重" : "需手动修正"}</Tag>
                                    </Tooltip>
                                ),
                            },
                        ]}
                    />
                </div>
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <Checkbox checked={cleanupLegacy} onChange={(event) => setCleanupLegacy(event.target.checked)} />
                    <span>
                        <span className="flex items-center gap-2 font-medium text-stone-950 dark:text-stone-100">
                            导入后清理旧配置
                            <ArrowRight className="size-3.5 text-stone-400" />
                            使用托管连接
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-stone-500">清除成功迁移渠道及顶层旧配置中的明文密钥，并把渠道选择 ID 更新为连接中心 ID。无效条目会原样保留，便于修正后再次迁移。</span>
                    </span>
                </label>
                {cleanupLegacy && migrationPreview?.plaintextSecrets ? <Alert className="mt-3" type="info" showIcon title={`预计清理最多 ${migrationPreview.plaintextSecrets} 个渠道中的旧明文密钥；此操作不会删除已加密导入的凭据。`} /> : null}
            </Modal>
        </main>
    );
}

function ProviderActions({ item, onEdit, onCopy, onDefault, onDelete }: { item: Provider; onEdit: () => void; onCopy: () => void; onDefault: () => void; onDelete: () => void }) {
    const menu: MenuProps = {
        items: [
            { key: "edit", label: "编辑", onClick: onEdit },
            { key: "copy", label: "复制", icon: <Copy className="size-3.5" />, onClick: onCopy },
            { key: "default", label: "设为默认", disabled: item.isDefault || !item.enabled, onClick: onDefault },
            { type: "divider" },
            { key: "delete", label: "删除", danger: true, onClick: onDelete },
        ],
    };
    return (
        <Dropdown menu={menu} trigger={["click"]}>
            <Button type="text" size="small" icon={<Ellipsis className="size-4" />} aria-label={`${item.name} 操作`} />
        </Dropdown>
    );
}

function ProviderCard({ item, testing, onEdit, onToggle, actions }: { item: Provider; testing: boolean; onEdit: () => void; onToggle: (checked: boolean) => void; actions: ReactNode }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-background p-4 dark:border-stone-800">
            <div className="flex items-start justify-between gap-3">
                <button type="button" className="min-w-0 text-left" onClick={onEdit}>
                    <div className="flex items-center gap-2 font-medium text-stone-950 dark:text-stone-100">
                        <span className="truncate">{item.name}</span>
                        {item.isDefault ? <Tag color="blue">默认</Tag> : null}
                    </div>
                    <div className="mt-1 text-xs uppercase text-stone-500">{item.protocol}</div>
                </button>
                {actions}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {item.capabilities.map((capability) => (
                    <Tag key={capability}>{capabilityOptions.find((option) => option.value === capability)?.label}</Tag>
                ))}
            </div>
            <div className="mt-4 text-xs text-stone-400 dark:text-stone-500">默认模型</div>
            <div className="mt-1 line-clamp-2 break-all text-sm leading-5 text-stone-600 dark:text-stone-300">{item.defaultModel || item.baseUrl || "未设置默认模型"}</div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-stone-100 pt-3 dark:border-stone-800">
                <ProviderStatusTag status={testing ? "testing" : item.connectionStatus} message={testing ? "正在检测连接，请稍候" : item.statusMessage} />
                <Switch size="small" checked={item.enabled} onChange={onToggle} aria-label={`${item.enabled ? "停用" : "启用"}${item.name}`} />
            </div>
        </div>
    );
}

function providerToInput(item: Provider): ProviderInput {
    return {
        id: item.id,
        kind: item.kind,
        protocol: item.protocol,
        name: item.name,
        baseUrl: item.baseUrl,
        capabilities: item.capabilities,
        models: item.models,
        defaultModel: item.defaultModel,
        timeout: item.timeout,
        enabled: item.enabled,
        isDefault: item.isDefault,
        executable: item.executable,
        workingDirectory: item.workingDirectory,
    };
}

function applyCleanedMigrationToConfig(mappings: Array<{ sourceId: string; providerId: string }>) {
    const configStore = useConfigStore.getState();
    const idMap = new Map(mappings.map((item) => [item.sourceId, item.providerId]));
    configStore.updateConfig(
        "localChannels",
        configStore.config.localChannels.filter((channel) => !idMap.has(channel.id)),
    );
    configStore.updateConfig("apiKey", "");
    for (const field of ["activeChannelId", "imageChannelId", "videoChannelId", "textChannelId", "audioChannelId"] as const) {
        const providerId = idMap.get(configStore.config[field]);
        if (providerId) configStore.updateConfig(field, providerId);
    }
}
