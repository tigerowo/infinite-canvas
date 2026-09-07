"use client";

import { Button, Card, Input, Select, Space, Tag, message } from "antd";
import { useEffect, useState } from "react";
import { loadModelPolicy, saveModelPolicy, type ModelKind, type ModelPolicy } from "./policy";
import { useUserStore } from "@/stores/use-user-store";

export function ModelPolicyPanel() {
    const token = useUserStore((state) => state.token);
    const [policy, setPolicy] = useState<ModelPolicy>({ imageTransfer: "url", overrides: {} });
    const [text, setText] = useState("");
    const [kind, setKind] = useState<ModelKind>("text");
    const [loading, setLoading] = useState(false);
    useEffect(() => { void loadModelPolicy().then(setPolicy).catch(() => {}); }, []);
    const add = () => {
        const name = text.trim().toLowerCase();
        if (!name) return;
        setPolicy((value) => ({ ...value, overrides: { ...value.overrides, [name]: kind } }));
        setText("");
    };
    const save = async () => {
        if (!token) return;
        setLoading(true);
        try { await saveModelPolicy(token, policy); message.success("模型与素材设置已保存"); }
        catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setLoading(false); }
    };
    return <Card title="模型与素材传输" size="small" extra={<Button type="primary" loading={loading} onClick={() => void save()}>保存</Button>}>
        <Space wrap>
            <span>图片传输：</span>
            <Select value={policy.imageTransfer} onChange={(value) => setPolicy({ ...policy, imageTransfer: value })} options={[{ value: "url", label: "公网 URL（默认）" }, { value: "base64", label: "Base64" }]} />
            <Input value={text} onChange={(event) => setText(event.target.value)} onPressEnter={add} placeholder="模型 ID" style={{ width: 240 }} />
            <Select value={kind} onChange={setKind} options={["text", "image", "video", "audio"].map((value) => ({ value, label: value }))} />
            <Button onClick={add}>添加或覆盖分类</Button>
        </Space>
        <Space wrap style={{ marginTop: 12 }}>{Object.entries(policy.overrides).map(([name, value]) => <Tag key={name} closable onClose={() => setPolicy({ ...policy, overrides: Object.fromEntries(Object.entries(policy.overrides).filter(([key]) => key !== name)) })}>{name}：{value}</Tag>)}</Space>
    </Card>;
}
