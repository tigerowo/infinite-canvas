"use client";

import { useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { App, Button, Input } from "antd";

import { resolveImageUrl, uploadImage } from "@/services/image-storage";

type AgentSkillCoverProps = {
    name: string;
    coverUrl?: string;
    coverStorageKey?: string;
    size?: number;
    iconSize?: number;
    borderColor?: string;
    background?: string;
};

type AgentSkillCoverEditorProps = AgentSkillCoverProps & {
    onChange: (value: { coverUrl: string; coverStorageKey: string }) => void;
};

export function AgentSkillCover({ name, coverUrl = "", coverStorageKey = "", size = 32, iconSize = 16, borderColor, background }: AgentSkillCoverProps) {
    const [src, setSrc] = useState(coverUrl);

    useEffect(() => {
        let active = true;
        setSrc(coverUrl);
        if (coverStorageKey) void resolveImageUrl(coverStorageKey, coverUrl)
            .then((url) => {
                if (active) setSrc(url);
            })
            .catch(() => {
                if (active) setSrc(coverUrl);
            });
        return () => {
            active = false;
        };
    }, [coverStorageKey, coverUrl]);

    return (
        <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg border" style={{ width: size, height: size, borderColor, background }}>
            {src
                ? <img src={src} alt={name} draggable={false} className="size-full object-contain" onError={() => setSrc("")} />
                : <Wrench aria-hidden style={{ width: iconSize, height: iconSize }} />}
        </span>
    );
}

export function AgentSkillCoverEditor({ name, coverUrl = "", coverStorageKey = "", size = 64, iconSize = 24, borderColor, background, onChange }: AgentSkillCoverEditorProps) {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    const uploadCover = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        setUploading(true);
        try {
            const image = await uploadImage(file);
            onChange({ coverUrl: image.url, coverStorageKey: image.storageKey });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "封面上传失败");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="flex items-center gap-3">
            <AgentSkillCover name={name} coverUrl={coverUrl} coverStorageKey={coverStorageKey} size={size} iconSize={iconSize} borderColor={borderColor} background={background} />
            <div className="grid min-w-0 flex-1 gap-2">
                <Input allowClear value={coverUrl} placeholder="填写图片链接，或从本地上传" onChange={(event) => onChange({ coverUrl: event.target.value, coverStorageKey: "" })} />
                <div className="flex gap-2">
                    <Button size="small" loading={uploading} onClick={() => inputRef.current?.click()}>上传图片</Button>
                    {(coverUrl || coverStorageKey) ? <Button size="small" type="text" onClick={() => onChange({ coverUrl: "", coverStorageKey: "" })}>移除</Button> : null}
                </div>
            </div>
            <input ref={inputRef} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void uploadCover(file); }} />
        </div>
    );
}
