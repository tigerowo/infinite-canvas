"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Checkbox, Flex, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useUserStore } from "@/stores/use-user-store";
import { adminLifecycle, type Capacity, type CleanupBatch, type CleanupPreview, type PolicyChangePreview, type RetentionPolicy } from "./api";

const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MB`;
const states: Record<string, string> = { preview: "待确认", running: "执行中", failed: "部分失败", complete: "已完成" };

export default function RetentionPanel() {
    const auth = useUserStore((s) => s.token);
    const { message } = App.useApp();
    const [policy, setPolicy] = useState<RetentionPolicy>();
    const [savedPolicy, setSavedPolicy] = useState<RetentionPolicy>();
    const [policyPreview, setPolicyPreview] = useState<{ policy: RetentionPolicy; impact: PolicyChangePreview }>();
    const [capacity, setCapacity] = useState<Capacity>();
    const [batches, setBatches] = useState<CleanupBatch[]>([]);
    const [preview, setPreview] = useState<CleanupPreview>();
    const [confirmation, setConfirmation] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const load = useCallback(async () => {
        if (!auth) return;
        const [p, c, b] = await Promise.all([adminLifecycle.policy(auth), adminLifecycle.capacity(auth), adminLifecycle.batches(auth)]);
        if (useUserStore.getState().token !== auth) return;
        setPolicy(p); setSavedPolicy(p); setCapacity(c); setBatches(b); setError("");
    }, [auth]);
    useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);
    const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
    const showPreview = (kind: "expiry" | "clear") => run(async () => { setPreview(await adminLifecycle.preview(auth, kind)); setConfirmation(""); });
    const migrateStorageScopes = () => run(async () => {
        const result = await adminLifecycle.migrateStorageScopes(auth);
        await load();
        if (result.skipped) {
            setError(`已迁移 ${result.migrated} 个旧对象，${result.skipped} 个仍未迁移：${(result.errors || []).slice(0, 3).join("；")}`);
        } else {
            message.success(`已核对并迁移 ${result.migrated} 个旧对象的存储清单`);
        }
    });
    const savePolicy = () => run(async () => {
        if (!policy || !savedPolicy) return;
        if (policy.mode === "retention" && (savedPolicy.mode === "forever" || policy.days < savedPolicy.days || (savedPolicy.execution !== "enforce" && policy.execution === "enforce"))) {
            setPolicyPreview({ policy, impact: await adminLifecycle.previewPolicy(auth, policy) });
            return;
        }
        await adminLifecycle.save(auth, policy); await load(); message.success("保留规则已保存");
    });
    return <main className="h-full overflow-y-auto bg-background px-4 py-5 md:px-8 md:py-8"><div className="mx-auto max-w-5xl space-y-6">
        {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void run(load)}>重新加载</Button>} />}
        <Card title="保留规则" variant="borderless" className="!rounded-2xl !border !border-stone-200 !bg-card dark:!border-stone-800">
            {policy && <Flex vertical gap={20}>
                <Typography.Paragraph type="secondary" className="!mb-0 max-w-3xl">这里同时管理 OSS 素材和数据库里的业务记录。按期限清理时，连续一段时间没有打开、播放、下载或编辑，才会进入清理；后台同步和普通列表浏览不会重新计时。</Typography.Paragraph>
                <Alert type="info" showIcon title={`当前规则：${policy.mode === "forever" ? "一直保存" : `连续 ${policy.days} 天无有效使用后清理`} · ${policy.execution === "enforce" ? "自动清理已开启" : "仅观察，不会自动删除"}`} description="账号、权限、余额和系统设置始终保留。" />
                <div className="grid gap-3 border-b border-[var(--ant-color-border-secondary)] pb-5 md:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)] md:gap-8">
                    <div>
                        <Typography.Text strong className="block">保留模式</Typography.Text>
                        <Typography.Text type="secondary">选择多久不使用后清理，或始终保存。</Typography.Text>
                    </div>
                    <Select aria-label="保留模式" value={policy.mode} onChange={(mode) => setPolicy({ ...policy, mode })} options={[{ value: "retention", label: "按期限清理" }, { value: "forever", label: "一直保存" }]} style={{ width: "min(100%, 320px)" }} />
                </div>
                {policy.mode === "retention" && <div className="grid gap-3 border-b border-[var(--ant-color-border-secondary)] pb-5 md:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)] md:gap-8">
                    <div>
                        <Typography.Text strong className="block">保留时长</Typography.Text>
                        <Typography.Text type="secondary">每次主动使用或编辑都会重新计算。</Typography.Text>
                    </div>
                    <Flex vertical gap={6}>
                        <Flex align="center" gap={8} wrap>
                            <InputNumber aria-label="保留天数" min={1} max={36500} precision={0} value={policy.days} onChange={(days) => days && setPolicy({ ...policy, days })} style={{ width: 140 }} />
                            <Typography.Text>天未使用后进入清理</Typography.Text>
                        </Flex>
                    </Flex>
                </div>}
                <div className="grid gap-3 border-b border-[var(--ant-color-border-secondary)] pb-5 md:grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)] md:gap-8">
                    <div>
                        <Typography.Text strong className="block">执行方式</Typography.Text>
                        <Typography.Text type="secondary">先查看将被清理的内容，确认无误后再开启自动清理。</Typography.Text>
                    </div>
                    <Select aria-label="清理执行方式" value={policy.execution} onChange={(execution) => setPolicy({ ...policy, execution })} options={[{ value: "observe", label: "只观察候选，不自动删除" }, { value: "enforce", label: "启用自动清理" }]} style={{ width: "min(100%, 320px)" }} />
                </div>
                <Checkbox className="items-start" checked={policy.storageReviewed} onChange={(e) => setPolicy({ ...policy, storageReviewed: e.target.checked })}>
                    <span className="block">我已关闭 OSS 的自动过期删除</span>
                    <Typography.Text type="secondary" className="block text-xs">请确认 OSS 不会因为“文件上传时间”自行删除。否则系统正在使用的素材可能提前失效。</Typography.Text>
                </Checkbox>
                <Alert className="!border-stone-200 !bg-stone-50 dark:!border-stone-700 dark:!bg-stone-900" type="info" showIcon title="这些内容会保留" description="账号登录、权限、余额、必要账务、模型渠道、密钥、OSS 设置，以及系统预设 Skill 和公共提示词。画布、素材、聊天、任务和历史记录按上方规则处理。" />
                {policy.clearing && <Alert type="warning" title="业务数据正在清空，相关写入暂停；失败项可在下方重试。" />}
                <Space wrap><Button type="primary" loading={busy} disabled={policy.clearing} onClick={() => void savePolicy()}>保存规则</Button><Button disabled={busy || policy.clearing} onClick={() => void showPreview("expiry")}>预览到期数据</Button></Space>
            </Flex>}
        </Card>
        <Card title="存储与清理批次" variant="borderless" loading={!policy && !error} className="!rounded-2xl !border !border-stone-200 !bg-card dark:!border-stone-800">
            <Space wrap className="mb-4"><Tag>已登记文件 {capacity?.physicalFiles ?? "—"} 个</Tag><Tag>物理占用 {capacity ? bytes(capacity.physicalBytes) : "—"}</Tag><Tag>删除未确认 {capacity ? bytes(capacity.pendingBytes) : "—"}</Tag><Button loading={busy} onClick={() => void run(load)}>刷新状态</Button><Button loading={busy} onClick={() => void migrateStorageScopes()}>核对并迁移旧存储清单</Button></Space>
            <Table rowKey="id" dataSource={batches} pagination={{ pageSize: 10 }} scroll={{ x: 640 }} columns={[
                { title: "类型", dataIndex: "kind", render: (kind) => kind === "clear" ? "主动清空" : "到期清理" },
                { title: "状态", dataIndex: "state", render: (state) => states[state] || state },
                { title: "结果", dataIndex: "error", render: (value) => value || "—" },
                { title: "操作", render: (_, batch) => batch.state === "failed" ? <Button disabled={busy} onClick={() => void run(async () => { await adminLifecycle.retry(auth, batch.id); await load(); })}>重试失败项</Button> : null },
            ]} />
        </Card>
        <Card title="立即清空业务数据" variant="borderless" loading={!policy && !error} className="!rounded-2xl !border !border-stone-200 !bg-card dark:!border-stone-800">
            <Typography.Paragraph>这会立即清空业务内容和素材，不受保留天数影响；账号、权限、余额和系统设置会保留。删除后不能靠切换为“一直保存”恢复。</Typography.Paragraph>
            <Button danger disabled={busy || policy?.clearing} onClick={() => void showPreview("clear")}>预览清空范围</Button>
        </Card>
        <Modal title={preview?.batch.kind === "clear" ? "确认清空业务数据" : "到期清理预览"} open={Boolean(preview)} onCancel={() => setPreview(undefined)} confirmLoading={busy} okText={preview?.batch.kind === "clear" ? "确认清空" : "执行本批次"} okButtonProps={{ danger: true, disabled: preview?.batch.kind === "clear" ? confirmation !== "清空业务数据" : policy?.execution !== "enforce" }} onOk={() => void run(async () => { if (!preview) return; await adminLifecycle.start(auth, preview.batch.id, confirmation); setPreview(undefined); await load(); })}>
            {error && <Alert className="mb-4" type="error" showIcon title="清理没有开始" description={error} />}
            <Typography.Paragraph>{preview?.files} 个文件，{preview?.records} 条业务记录，共 {bytes(preview?.bytes || 0)}。</Typography.Paragraph>
            <Typography.Paragraph>保留：{preview?.preserved.join("、")}。</Typography.Paragraph>
            {preview?.batch.kind === "clear" ? <Input aria-label="清空确认文字" placeholder="输入：清空业务数据" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /> : policy?.execution === "observe" && <Alert type="info" title="当前为观察模式，此预览不会执行删除。" />}
        </Modal>
        <Modal title="确认修改保留规则" open={Boolean(policyPreview)} onCancel={() => setPolicyPreview(undefined)} confirmLoading={busy} okText="确认保存规则" onOk={() => void run(async () => {
            if (!policyPreview) return;
            await adminLifecycle.save(auth, policyPreview.policy, policyPreview.impact.id);
            setPolicyPreview(undefined); await load(); message.success("保留规则已保存");
        })}>
            <Typography.Paragraph>改为连续 {policyPreview?.policy.days} 天无有效活动后到期。当前候选共 {policyPreview?.impact.files} 个文件、{policyPreview?.impact.records} 条业务记录，{bytes(policyPreview?.impact.bytes || 0)}。</Typography.Paragraph>
            <Typography.Paragraph>本次修改新增到期候选：{policyPreview?.impact.additionalFiles} 个文件、{policyPreview?.impact.additionalRecords} 条业务记录。账号和配置保留。</Typography.Paragraph>
            <Alert type={policyPreview?.policy.execution === "enforce" ? "warning" : "info"} showIcon title={policyPreview?.policy.execution === "enforce" ? "保存后自动清理将按新规则扫描，仍需逐项核对删除资格。" : "保存后仍为观察模式，不自动删除。"} />
        </Modal>
    </div></main>;
}
