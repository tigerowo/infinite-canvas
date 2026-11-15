"use client";

import { App, AutoComplete, Button, Form, Input, Popconfirm, Segmented, Select, Switch, Tag } from "antd";
import { useEffect, useRef, useState } from "react";

import { WorkflowFieldMappingEditor } from "@/components/workflow/workflow-field-mapping-editor";
import { WorkflowGraphEditor } from "@/components/workflow/workflow-graph-editor";
import { WorkflowTestWorkbench } from "@/components/workflow/workflow-test-workbench";
import { parseComfyWorkflowJSON } from "@/lib/comfy-workflow-json";
import { mergeWorkflowFieldMappings, normalizeWorkflowFieldMappings, type WorkflowCapability, type WorkflowEntry, type WorkflowKind } from "@/lib/workflow-channel";
import { createComfyBridge, deleteComfyBridge, inspectComfyBridge, listComfyBridges, type ComfyBridgeSummary } from "@/services/api/comfy-bridge";
import { inspectComfyWorkflow } from "@/services/api/comfy-workflow";
import { inspectRunningHub } from "@/services/api/runninghub";
import type { AdminModelChannel } from "@/services/api/admin";
import { useConfigStore } from "@/stores/use-config-store";
import styles from "./workflow-channel-pane.module.css";

export type WorkflowChannelSettings = {
    id: string;
    protocol: "runninghub" | "comfyui";
    baseUrl: string;
    apiKey: string;
    uploadApiKey?: string;
    bridgeId?: string;
    comfyUrl?: string;
    workflowDir?: string;
};

type Props = {
    channel: WorkflowChannelSettings;
    workflows: WorkflowEntry[];
    token: string;
    admin?: { index?: number; channel: AdminModelChannel };
    onChannelChange: (patch: Partial<WorkflowChannelSettings>) => void;
    onBridgeDeleted: (bridgeId: string) => void;
    onWorkflowsChange: (workflows: WorkflowEntry[]) => void;
    onBeforeTest: () => Promise<string>;
};

const capabilityOptions = [{ label: "图片", value: "image" }, { label: "视频", value: "video" }, { label: "音频", value: "audio" }];
const entryKey = (item: WorkflowEntry) => `${item.kind}:${item.workflowId}`;

export function WorkflowChannelPane({ channel, workflows, token, admin, onChannelChange, onBridgeDeleted, onWorkflowsChange, onBeforeTest }: Props) {
    const { message } = App.useApp();
    const [selectedKey, setSelectedKey] = useState("");
    const [kind, setKind] = useState<WorkflowKind>("workflow");
    const [workflowId, setWorkflowId] = useState("");
    const [title, setTitle] = useState("");
    const [capability, setCapability] = useState<WorkflowCapability>("image");
    const [jsonText, setJsonText] = useState("");
    const [mode, setMode] = useState<"fields" | "test">("fields");
    const [busy, setBusy] = useState(false);
    const [bridges, setBridges] = useState<ComfyBridgeSummary[]>([]);
    const [bridgeName, setBridgeName] = useState("");
    const [newToken, setNewToken] = useState("");
    const [newTokenBridgeId, setNewTokenBridgeId] = useState("");
    const activeRef = useRef(true);
    const selected = workflows.find((item) => entryKey(item) === selectedKey);
    const bridge = bridges.find((item) => item.id === channel.bridgeId);
    const comfyServers = useConfigStore((state) => state.publicSettings?.comfy?.servers);

    useEffect(() => {
        activeRef.current = true;
        return () => {
            activeRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (channel.protocol !== "comfyui" || !token) return;
        void listComfyBridges(token, Boolean(admin)).then(setBridges).catch((error) => message.error(error instanceof Error ? error.message : "读取 Bridge 失败"));
    }, [channel.protocol, token, admin?.index]);

    const choose = (key?: string) => {
        const item = workflows.find((entry) => entryKey(entry) === key);
        setSelectedKey(key || "");
        setKind(item?.kind || "workflow");
        setWorkflowId(item?.workflowId || "");
        setTitle(item?.title || "");
        setCapability(item?.capability || "image");
        setJsonText(item?.workflowJson ? JSON.stringify(item.workflowJson, null, 2) : "");
    };

    const saveEntry = (item: WorkflowEntry) => {
        const key = entryKey(item);
        const index = workflows.findIndex((entry) => entryKey(entry) === key);
        onWorkflowsChange(index < 0 ? [...workflows, item] : workflows.map((entry, current) => current === index ? item : entry));
        setSelectedKey(key);
    };

    const pull = async () => {
        const id = workflowId.trim();
        if (!id) return message.warning("请先填写工作流 ID");
        setBusy(true);
        try {
            let incoming: WorkflowEntry;
            if (channel.protocol === "runninghub") {
                if (!token) throw new Error("拉取 RunningHub 参数请先登录");
                incoming = await inspectRunningHub(token, { baseUrl: channel.baseUrl, apiKey: channel.apiKey, kind, workflowId: id, title, capability }, admin);
            } else {
                if (!token) throw new Error("拉取 ComfyUI 参数请先登录");
                const source = jsonText.trim() ? JSON.parse(jsonText) as Record<string, unknown> : selected?.workflowJson;
                if (!channel.bridgeId) {
                    if (!source) throw new Error("直连渠道请先粘贴 ComfyUI API JSON，再拉取参数");
                    const inspected = await inspectComfyWorkflow(token, { workflowJson: source, capability });
                    incoming = { provider: "comfyui", kind: "workflow", workflowId: id, title: title.trim() || id, capability, enabled: true, fields: inspected.fields, workflowJson: inspected.workflowJson };
                } else {
                    const discovered = bridge?.capabilities?.workflows?.find((entry) => entry.workflowId === id);
                    const inspected = await inspectComfyBridge(token, { bridgeId: channel.bridgeId, workflowId: id, workflowJson: source, capability }, Boolean(admin));
                    incoming = { provider: "comfyui", kind: "workflow", workflowId: id, title: title.trim() || discovered?.title || id, capability, enabled: true, fields: inspected.fields, workflowJson: inspected.workflowJson, workflowGraph: inspected.workflowGraph };
                }
            }
            if (!activeRef.current) return;
            const old = workflows.find((entry) => entryKey(entry) === entryKey(incoming));
            const fields = old?.fields.length ? mergeWorkflowFieldMappings(old.fields, incoming.fields, capability) : normalizeWorkflowFieldMappings(incoming.fields, capability);
            const next = { ...incoming, enabled: old?.enabled ?? true, comfyServerId: old?.comfyServerId, fields, workflowGraph: incoming.workflowGraph || old?.workflowGraph };
            saveEntry(next);
            setTitle(next.title);
            setJsonText(next.workflowJson ? JSON.stringify(next.workflowJson, null, 2) : "");
            message.success(channel.protocol === "runninghub" ? next.fields.some((field) => field.enabled !== false && ["referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(field.source || "")) ? `RunningHub ${kind === "app" ? "App" : "工作流"}参数已保存；生成时会调用 RunningHub 素材上传接口` : `RunningHub ${kind === "app" ? "App" : "工作流"}参数已重新拉取并保存` : "ComfyUI 工作流配置已保存");
        } catch (error) {
            if (activeRef.current) message.error(error instanceof Error ? error.message : "拉取工作流失败");
        } finally {
            if (activeRef.current) setBusy(false);
        }
    };

    const saveJson = async () => {
        if (!selected || selected.kind === "app") return;
        try {
            const source = JSON.parse(jsonText) as Record<string, unknown>;
            if (channel.protocol === "runninghub") {
                const parsed = parseComfyWorkflowJSON(source);
                saveEntry({ ...selected, workflowJson: parsed.workflowJson, workflowGraph: parsed.workflowGraph || selected.workflowGraph });
                return;
            }
            if (!token) return message.error("应用 ComfyUI JSON 请先登录");
            setBusy(true);
            try {
                if (!channel.bridgeId) {
                    const inspected = await inspectComfyWorkflow(token, { workflowJson: source, capability: selected.capability });
                    if (!activeRef.current) return;
                    saveEntry({ ...selected, workflowJson: inspected.workflowJson, fields: mergeWorkflowFieldMappings(selected.fields, inspected.fields, selected.capability) });
                    setJsonText(JSON.stringify(inspected.workflowJson, null, 2));
                    return;
                }
                const inspected = await inspectComfyBridge(token, { bridgeId: channel.bridgeId, workflowId: selected.workflowId, workflowJson: source, capability: selected.capability }, Boolean(admin));
                if (!activeRef.current) return;
                saveEntry({ ...selected, workflowJson: inspected.workflowJson, workflowGraph: inspected.workflowGraph || selected.workflowGraph, fields: mergeWorkflowFieldMappings(selected.fields, inspected.fields, selected.capability) });
                setJsonText(JSON.stringify(inspected.workflowJson, null, 2));
            } finally {
                if (activeRef.current) setBusy(false);
            }
        } catch (error) {
            if (activeRef.current) message.error(error instanceof Error ? error.message : "API JSON 无效");
        }
    };

    const refreshBridges = async () => {
        if (!token) return;
        setBridges(await listComfyBridges(token, Boolean(admin)));
    };

    const registerBridge = async () => {
        if (!token) return message.warning("注册 Bridge 请先登录");
        try {
            const created = await createComfyBridge(token, bridgeName, Boolean(admin));
            setNewToken(created.token);
            setNewTokenBridgeId(created.bridge.id);
            onChannelChange({ bridgeId: created.bridge.id });
            await refreshBridges();
            setBridgeName("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册 Bridge 失败");
        }
    };

    const serverURL = typeof window === "undefined" ? "" : window.location.origin;
    const bridgeArgs = `--server "${serverURL}" --token "${newToken}" --comfy "${channel.comfyUrl || "http://127.0.0.1:8188"}" --workflow-dir "${channel.workflowDir || "workflows"}"`;
    const windowsBridgeCommand = `.\\InfiniteCanvas-ComfyBridge.exe ${bridgeArgs}`;
    const linuxBridgeCommand = `chmod +x ./InfiniteCanvas-ComfyBridge-linux-amd64 && ./InfiniteCanvas-ComfyBridge-linux-amd64 ${bridgeArgs}`;

    return <div className={`${styles.root} space-y-3`} inert={busy}>
        {channel.protocol === "runninghub" ? <div className="grid gap-3 md:grid-cols-2">
            <Form.Item label="Base URL" className="!mb-0"><AutoComplete value={channel.baseUrl} options={[{ label: "中国站 · https://www.runninghub.cn", value: "https://www.runninghub.cn" }, { label: "国际站 · https://www.runninghub.ai", value: "https://www.runninghub.ai" }]} onChange={(baseUrl) => onChannelChange({ baseUrl })}><Input /></AutoComplete></Form.Item>
            <Form.Item label="积分 API Key（提交、查询）" className="!mb-0"><Input.Password value={channel.apiKey} onChange={(event) => onChannelChange({ apiKey: event.target.value })} placeholder={admin?.index === undefined ? "" : "留空沿用已保存密钥"} /></Form.Item>
            <Form.Item label="素材上传 API Key（企业级）" className="!mb-0 md:col-span-2"><Input.Password value={channel.uploadApiKey || ""} onChange={(event) => onChannelChange({ uploadApiKey: event.target.value })} placeholder="没有参考素材可以留空" /></Form.Item>
        </div> : <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
                <Form.Item label="Bridge 设备" className="!mb-0"><Select value={channel.bridgeId || undefined} options={bridges.map((item) => ({ value: item.id, label: `${item.name} · ${item.online ? "在线" : "离线"}` }))} onChange={(bridgeId) => { onChannelChange({ bridgeId }); if (bridgeId !== newTokenBridgeId) setNewToken(""); }} /></Form.Item>
                <Form.Item label="设备状态" className="!mb-0"><div className="flex items-center gap-2 pt-1"><Tag color={bridge?.online ? "success" : "default"}>{bridge?.online ? "在线" : "未连接"}</Tag><Button size="small" onClick={() => void refreshBridges()}>刷新发现</Button>{bridge ? <Popconfirm title="删除此 Bridge 设备？" onConfirm={async () => {
                    const bridgeId = bridge.id;
                    try {
                        await deleteComfyBridge(token, bridgeId, Boolean(admin));
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "删除设备失败");
                        return;
                    }
                    onBridgeDeleted(bridgeId);
                    setBridges((current) => current.filter((item) => item.id !== bridgeId));
                    if (newTokenBridgeId === bridgeId) setNewToken("");
                    void refreshBridges().catch(() => {});
                }}><Button size="small" danger>删除设备</Button></Popconfirm> : null}</div></Form.Item>
                <Form.Item label="ComfyUI 地址" className="!mb-0"><Input value={channel.comfyUrl || bridge?.capabilities?.comfyUrl || ""} onChange={(event) => onChannelChange({ comfyUrl: event.target.value })} placeholder="http://127.0.0.1:8188" /></Form.Item>
                <Form.Item label="工作流目录" className="!mb-0"><Input value={channel.workflowDir || bridge?.capabilities?.workflowDir || ""} onChange={(event) => onChannelChange({ workflowDir: event.target.value })} placeholder="workflows" /></Form.Item>
            </div>
            {!channel.bridgeId ? <div className="rounded-md border border-[var(--ant-color-border-secondary)] bg-[var(--ant-color-fill-quaternary)] px-3 py-2 text-xs text-[var(--ant-color-text-secondary)]">未选择 Bridge：这条渠道由服务端直连「系统设置 → ComfyUI 服务地址」里的服务端执行，工作流参数用下方 API JSON 拉取。</div> : null}
            <div className="flex gap-2"><Input value={bridgeName} onChange={(event) => setBridgeName(event.target.value)} placeholder="新 Bridge 名称" /><Button onClick={() => void registerBridge()}>注册 Bridge</Button></div>
            {newToken && channel.bridgeId === newTokenBridgeId ? <div className="space-y-2 rounded border p-3 text-xs">专用 Token 只显示这一次，关闭后无法找回：<Input.Password readOnly visibilityToggle value={newToken} /><div>下载对应程序，在能访问 ComfyUI 的机器上运行：</div><pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[var(--muted)] p-2 select-text">Windows PowerShell: {windowsBridgeCommand}{"\n"}Linux: {linuxBridgeCommand}</pre><div className="flex gap-2"><Button size="small" onClick={() => void navigator.clipboard.writeText(windowsBridgeCommand).then(() => message.success("Windows 启动命令已复制"))}>复制 Windows 命令</Button><Button size="small" onClick={() => void navigator.clipboard.writeText(linuxBridgeCommand).then(() => message.success("Linux 启动命令已复制"))}>复制 Linux 命令</Button><Button size="small" onClick={() => setNewToken("")}>我已保存</Button></div><div>Linux ARM64：将命令中的 amd64 改为 arm64。</div></div> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--ant-color-border-secondary)] bg-[var(--ant-color-fill-quaternary)] px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2"><Tag color="blue" className="!m-0 shrink-0">下载 Bridge</Tag><span className="text-xs text-[var(--ant-color-text-secondary)]">在可访问 ComfyUI 的设备运行独立 Bridge，一个 Bridge 可运行该目录中的多条工作流，启动后点击“刷新发现”同步工作流</span></div>
                <div className="flex flex-wrap gap-2"><Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge.exe" download>下载 Windows</Button><Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge-linux-amd64" download>下载 Linux x64</Button><Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge-linux-arm64" download>下载 Linux ARM64</Button></div>
            </div>
        </div>}
        <div className="grid gap-3 md:grid-cols-12">
            <Form.Item label="工作流用途" className="!mb-0 md:col-span-6"><Select value={capability} options={capabilityOptions} onChange={(value) => { setCapability(value); if (selected) saveEntry({ ...selected, capability: value }); }} /></Form.Item>
            <Form.Item label="已保存条目" className="!mb-0 md:col-span-6"><Select allowClear value={selectedKey || undefined} options={workflows.map((item) => ({ value: entryKey(item), label: `${item.kind === "app" ? "App" : "Workflow"} · ${item.title || item.workflowId} · ${item.enabled ? "启用" : "停用"}` }))} onChange={choose} placeholder="选择已保存 Workflow / App" /></Form.Item>
            {channel.protocol === "runninghub" ? <Form.Item label="类型" className="!mb-0 md:col-span-3"><Segmented block value={kind} options={[{ label: "Workflow", value: "workflow" }, { label: "App", value: "app" }]} onChange={(value) => { choose(); setKind(value as WorkflowKind); }} /></Form.Item> : null}
            <Form.Item label={kind === "app" ? "webappId" : "workflowId"} className={`!mb-0 ${channel.protocol === "runninghub" ? "md:col-span-3" : "md:col-span-6"}`}><Input value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} /></Form.Item>
            <Form.Item label="显示名称" className="!mb-0 md:col-span-6"><Input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => selected && saveEntry({ ...selected, title: title.trim() || selected.workflowId })} /></Form.Item>
            {channel.protocol === "comfyui" && (comfyServers?.length ?? 0) > 0 ? <Form.Item label="执行服务端" className="!mb-0 md:col-span-6" extra={channel.bridgeId ? "渠道已绑定 Bridge，此设置只在未绑定 Bridge 时生效" : "未绑定 Bridge 时由服务端直连该服务端"}>
                <Select allowClear placeholder="默认地址" value={selected?.comfyServerId || undefined} options={(comfyServers ?? []).map((item) => ({ label: item.name, value: item.id }))} onChange={(value) => selected && saveEntry({ ...selected, comfyServerId: value || undefined })} />
            </Form.Item> : null}
            {channel.protocol === "comfyui" && bridge?.capabilities?.workflows?.length ? <Form.Item label="Bridge 发现的工作流" className="!mb-0 md:col-span-6"><Select showSearch options={bridge.capabilities.workflows.map((item) => ({ value: item.workflowId, label: item.title || item.workflowId }))} onChange={(id) => { setWorkflowId(id); setJsonText(""); }} /></Form.Item> : null}
            <Form.Item label="操作" className="!mb-0 md:col-span-12"><div className="flex flex-wrap items-center gap-2"><Button type="primary" loading={busy} onClick={() => void pull()}>{selected ? "重新拉取参数" : "拉取参数"}</Button><Switch checked={selected?.enabled === true} disabled={!selected} checkedChildren="启用" unCheckedChildren="停用" onChange={(enabled) => selected && saveEntry({ ...selected, enabled })} /><Popconfirm title="删除当前工作流？" onConfirm={() => { if (!selected) return; onWorkflowsChange(workflows.filter((item) => entryKey(item) !== selectedKey)); choose(); }}><Button danger disabled={!selected}>删除</Button></Popconfirm></div></Form.Item>
        </div>
        <Segmented block value={mode} options={[{ label: "字段配置", value: "fields" }, { label: "测试画布", value: "test" }]} onChange={(value) => setMode(value as "fields" | "test")} />
        {mode === "fields" ? <>
            {selected?.kind === "app" ? <WorkflowFieldMappingEditor fields={selected.fields} onChange={(fields) => saveEntry({ ...selected, fields })} /> : <WorkflowGraphEditor workflowJson={selected?.workflowJson} workflowGraph={selected?.workflowGraph} fields={selected?.fields || []} onChange={(fields) => selected && saveEntry({ ...selected, fields })} disabled={!selected} emptyDescription={`请先拉取 ${channel.protocol === "runninghub" ? "RunningHub" : "ComfyUI"} 工作流`} />}
            {kind !== "app" ? <details className="rounded border border-[var(--ant-color-border)] p-2"><summary>查看或编辑 ComfyUI API JSON</summary><Input.TextArea className="!mt-2" rows={12} spellCheck={false} value={jsonText} disabled={busy} onChange={(event) => setJsonText(event.target.value)} onBlur={channel.protocol === "runninghub" ? () => void saveJson() : undefined} placeholder={'{"3":{"class_type":"...","inputs":{}}}'} />{channel.protocol === "comfyui" ? <div className="mt-2 flex justify-end"><Button size="small" loading={busy} disabled={busy || !selected} onClick={() => void saveJson()}>应用 JSON</Button></div> : null}</details> : null}
        </> : <><WorkflowTestWorkbench key={`${admin ? "system" : "personal"}:${channel.id}:${selected?.kind || kind}:${selected?.workflowId || ""}`} workflowRef={{ scope: admin ? "system" : "personal", channelId: channel.id, kind: selected?.kind || kind, workflowId: selected?.workflowId || "" }} token={token} provider={channel.protocol} workflowId={selected?.workflowId || ""} workflowKind={selected?.kind || kind} title={selected?.title || ""} capability={selected?.capability || capability} fields={selected?.fields || []} disabled={!selected || !selected.enabled || !token} disabledReason={!selected ? "请先拉取或选择一个已保存的工作流" : !token ? "请先登录" : "此条工作流已停用"} onBeforeTest={onBeforeTest} /></>}
    </div>;
}
