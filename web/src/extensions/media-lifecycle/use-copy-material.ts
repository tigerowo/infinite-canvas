"use client";
import { App } from "antd";
import { useCopyText } from "@/hooks/use-copy-text";
import { shareMaterial } from "./api";
import { objectId } from "./material-id";

export function useCopyMaterial() {
    const { message } = App.useApp();
    const copy = useCopyText();
    return async (storageKey?: string) => {
        try {
            const id = objectId(storageKey);
            if (!id) throw new Error("请先将素材上传到云存储，再复制素材 ID");
            const material = await shareMaterial(id);
            copy(material.shareId, "素材 ID 已复制，登录后可粘贴为参考素材");
        } catch (error) { message.error(error instanceof Error ? error.message : "复制素材 ID 失败"); }
    };
}
