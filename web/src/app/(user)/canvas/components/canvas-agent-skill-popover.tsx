"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FileUp, Pencil, Search, Trash2, Wrench } from "lucide-react";
import { App, Button, Empty, Form, Input, Modal, Popover, Spin } from "antd";

import { AgentSkillCover, AgentSkillCoverEditor } from "@/components/agent-skill-cover";
import { canvasThemes } from "@/lib/canvas-theme";
import { AGENT_SKILL_CONTENT_MAX_LENGTH, type AgentSkill } from "@/services/api/agent-skills";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasAgentSkillSelection } from "../types";

type CanvasAgentSkillPopoverProps = {
    selectedSkills?: CanvasAgentSkillSelection[];
    onSelect: (skill: CanvasAgentSkillSelection) => void;
    onDeleteSelected: (id: string, source: CanvasAgentSkillSelection["source"]) => void;
};

export function CanvasAgentSkillPopover({ selectedSkills, onSelect, onDeleteSelected }: CanvasAgentSkillPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const token = useUserStore((state) => state.token);
    const systemSkills = useAgentSkillStore((state) => state.systemSkills);
    const userSkills = useAgentSkillStore((state) => state.userSkills);
    const isLoading = useAgentSkillStore((state) => state.isLoading);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const importSkill = useAgentSkillStore((state) => state.importSkill);
    const updateSkill = useAgentSkillStore((state) => state.updateSkill);
    const deleteSkill = useAgentSkillStore((state) => state.deleteSkill);
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<Pick<AgentSkill, "name" | "description" | "coverUrl" | "coverStorageKey" | "content">>();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<"system" | "user">("system");
    const [query, setQuery] = useState("");
    const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const editingCoverUrl = Form.useWatch("coverUrl", form);
    const editingCoverStorageKey = Form.useWatch("coverStorageKey", form);

    useEffect(() => {
        if (open) void loadSkills().catch((error) => message.error(error instanceof Error ? error.message : "Skill 加载失败"));
    }, [loadSkills, message, open, token]);

    const skills = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return (tab === "system" ? systemSkills : userSkills).filter((skill) => !keyword || `${skill.name} ${skill.description}`.toLowerCase().includes(keyword));
    }, [query, systemSkills, tab, userSkills]);

    const selectSkill = (skill: AgentSkill) => {
        onSelect({ id: skill.id, name: skill.name, source: skill.source });
        setOpen(false);
    };

    const removeSkill = (skill: AgentSkill) => {
        modal.confirm({
            title: `删除「${skill.name}」？`,
            content: "删除后无法恢复，已发送的历史消息不会被删除。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await deleteSkill(skill.id);
                if (selectedSkills?.some((selected) => selected.id === skill.id && selected.source === skill.source)) onDeleteSelected(skill.id, skill.source);
                message.success("Skill 已删除");
            },
        });
    };

    const editSkill = (skill: AgentSkill) => {
        form.setFieldsValue({ name: skill.name, description: skill.description, coverUrl: skill.coverUrl, coverStorageKey: skill.coverStorageKey, content: skill.content });
        setEditingSkill(skill);
        setOpen(false);
    };

    const saveEditingSkill = async () => {
        if (!editingSkill) return;
        setIsSaving(true);
        try {
            const saved = await updateSkill(editingSkill.id, await form.validateFields());
            if (selectedSkills?.some((selected) => selected.id === saved.id && selected.source === saved.source)) onSelect({ id: saved.id, name: saved.name, source: saved.source });
            setEditingSkill(null);
            message.success("Skill 已保存");
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const content = (
        <div className="w-[420px] max-w-[calc(100vw-24px)]" onPointerDown={(event) => event.stopPropagation()}>
            <div className="relative mb-3">
                <div className="text-sm font-semibold">Skill</div>
                {tab === "user" ? (
                    <Button size="small" className="!absolute !right-0 !top-1/2 !-translate-y-1/2" icon={<FileUp className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>导入</Button>
                ) : null}
            </div>
            <div className="mb-3 flex items-center gap-2">
                <div className="flex shrink-0 rounded-lg p-0.5" style={{ background: theme.node.fill }}>
                    <button type="button" className="rounded-md px-3 py-1.5 text-xs" style={tab === "system" ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.muted }} onClick={() => setTab("system")}>通用</button>
                    <button type="button" className="rounded-md px-3 py-1.5 text-xs" style={tab === "user" ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.muted }} onClick={() => setTab("user")}>我的</button>
                </div>
                <Input allowClear size="small" prefix={<Search className="size-3.5 opacity-55" />} placeholder="搜索 Skill" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="thin-scrollbar h-[260px] overflow-y-auto">
                <Spin spinning={isLoading}>
                    {skills.length ? skills.map((skill) => (
                        <div
                            key={skill.id}
                            className="group flex items-center gap-2 rounded-xl px-2 py-2 transition hover:bg-[var(--skill-hover-bg)]"
                            style={{ "--skill-hover-bg": theme.toolbar.itemHover } as CSSProperties}
                        >
                            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => selectSkill(skill)}>
                                <AgentSkillCover name={skill.name} coverUrl={skill.coverUrl} coverStorageKey={skill.coverStorageKey} borderColor={theme.node.stroke} background={theme.node.fill} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium">{skill.name}</span>
                                    <span className="block truncate text-xs opacity-55">{skill.description || "自定义创作工作流"}</span>
                                </span>
                            </button>
                            {tab === "user" ? (
                                <span className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
                                    <Button type="text" shape="circle" size="small" icon={<Pencil className="size-3.5" />} aria-label={`编辑 ${skill.name}`} onClick={() => editSkill(skill)} />
                                    <Button type="text" shape="circle" size="small" icon={<Trash2 className="size-3.5" />} aria-label={`删除 ${skill.name}`} onClick={() => removeSkill(skill)} />
                                </span>
                            ) : null}
                        </div>
                    )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === "system" ? "暂无通用 Skill" : "导入 Markdown 或文本创建 Skill"} />}
                </Spin>
            </div>
            <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                hidden
                onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try {
                        const skill = await importSkill(file);
                        onSelect({ id: skill.id, name: skill.name, source: skill.source });
                        message.success("Skill 已导入");
                        setOpen(false);
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "Skill 导入失败");
                    }
                }}
            />
        </div>
    );

    return (
        <>
            <Popover
                trigger="click"
                placement="topLeft"
                open={open}
                onOpenChange={setOpen}
                content={content}
                styles={{ container: { padding: 14, background: theme.toolbar.panel, color: theme.node.text, border: `1px solid ${theme.node.stroke}`, borderRadius: 16 } }}
            >
                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.text }} icon={<Wrench className="size-4" />} title="Skill" aria-label="Skill" />
            </Popover>
            <Modal title="编辑 Skill" open={Boolean(editingSkill)} width={920} footer={null} destroyOnHidden onCancel={() => setEditingSkill(null)}>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Form.Item name="coverUrl" hidden><Input /></Form.Item>
                    <Form.Item name="coverStorageKey" hidden><Input /></Form.Item>
                    <div className="grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
                        <div>
                            <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入 Skill 名称" }]}><Input /></Form.Item>
                            <Form.Item name="description" label="描述"><Input.TextArea rows={3} /></Form.Item>
                            <Form.Item label="封面图片">
                                <AgentSkillCoverEditor name={editingSkill?.name || "Skill"} coverUrl={editingCoverUrl} coverStorageKey={editingCoverStorageKey} borderColor={theme.node.stroke} background={theme.node.fill} onChange={(value) => form.setFieldsValue(value)} />
                            </Form.Item>
                            <div className="flex justify-end">
                                <Button type="primary" loading={isSaving} onClick={() => void saveEditingSkill()}>保存</Button>
                            </div>
                        </div>
                        <Form.Item name="content" label="Skill 内容" style={{ marginBottom: 16 }} rules={[{ required: true, message: "请输入 Skill 内容" }]}>
                            <Input.TextArea count={{ max: AGENT_SKILL_CONTENT_MAX_LENGTH, strategy: (value) => Array.from(value).length, show: ({ count, maxLength }) => `${count} / ${maxLength}`, exceedFormatter: (value, { max }) => Array.from(value).slice(0, max).join("") }} style={{ height: "min(480px, calc(100vh - 250px))", resize: "none" }} />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </>
    );
}
