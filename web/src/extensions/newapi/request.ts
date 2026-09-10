import { channelIdForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { loadModelPolicy } from "@/extensions/model-capabilities/policy";
import { publicImageURL, publicMediaURL } from "@/extensions/public-media/references";
import { imageToDataUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import type { VideoReferenceInput, VideoResponse } from "@/services/api/video";

export { isNewAPIConfig } from "./config";

async function referenceImageURL(image: ReferenceImage) {
    if (useUserStore.getState().token) return publicImageURL(image);
    const data = await imageToDataUrl(image);
    if (!data.startsWith("data:image/")) throw new Error("无法读取参考图片");
    return data;
}

async function referenceMediaURL(media: { url: string; storageKey?: string; type: string }) {
    if (!useUserStore.getState().token && !media.storageKey && media.url.startsWith("https://")) return media.url;
    return publicMediaURL(media);
}

export async function newAPIImageFile(image: ReferenceImage): Promise<Blob> {
    const data = await imageToDataUrl(image);
    if (!data.startsWith("data:image/")) throw new Error("无法读取参考图片文件");
    const response = await fetch(data);
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith("image/")) throw new Error("参考图片为空或格式无效");
    return blob;
}

export function newAPIVideoSize(size: string, quality: string) {
    if (!size || size === "auto") return undefined;
    if (/^[1-9]\d*x[1-9]\d*$/.test(size)) return size;
    const ratio = /^([1-9]\d*):([1-9]\d*)$/.exec(size);
    if (!ratio) throw new Error("NewAPI 视频尺寸必须是像素尺寸或宽高比");
    const short = ({ low: 480, medium: 720, high: 720, auto: 720 } as Record<string, number>)[quality] || Number(quality.replace(/p$/, ""));
    if (!Number.isInteger(short) || short < 1) throw new Error("无效的视频分辨率");
    const w = Number(ratio[1]), h = Number(ratio[2]);
    return `${Math.round(short * w / Math.min(w, h) / 2) * 2}x${Math.round(short * h / Math.min(w, h) / 2) * 2}`;
}

export async function createNewAPIVideoRequest(config: AiConfig, model: string, prompt: string, input: Required<VideoReferenceInput>) {
    model = model.trim();
    if (!model) throw new Error("模型名称不能为空，请先选择可用的视频模型");
    const seconds = Number(config.videoSeconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error("视频时长必须是 1 到 30 之间的整数秒");
    const size = newAPIVideoSize(config.size, config.vquality);
    const policy = await loadModelPolicy();
    const profileKey = `${channelIdForActiveModel(config)}::${model.trim().toLowerCase()}`;
    const extended = policy.newapiVideoProfiles?.[profileKey] === "canvas-v1";
    if (extended) {
        const media: Array<{ type: string; role: string; url: string }> = [];
        for (const image of input.references) media.push({ type: "image", role: "reference", url: await referenceImageURL(image) });
        if (input.firstFrame) media.push({ type: "image", role: "first_frame", url: await referenceImageURL(input.firstFrame) });
        if (input.lastFrame) media.push({ type: "image", role: "last_frame", url: await referenceImageURL(input.lastFrame) });
        for (const video of input.videoReferences) media.push({ type: "video", role: "reference", url: await referenceMediaURL(video) });
        for (const audio of input.audioReferences) media.push({ type: "audio", role: "reference", url: await referenceMediaURL(audio) });
        return { model, prompt, seconds: String(seconds), ...(size ? { size } : {}), metadata: { canvas_video: { version: 1, media } } };
    }
    if (input.lastFrame || input.videoReferences.length || input.audioReferences.length || input.references.length + Number(Boolean(input.firstFrame)) > 1) {
        throw new Error("当前 NewAPI 视频通道使用标准协议，仅支持一张参考图；多素材需要管理员为该渠道和模型启用已安装的 Canvas v1 插件扩展");
    }
    const image = input.firstFrame || input.references[0];
    if (!image) return { model, prompt, seconds: String(seconds), ...(size ? { size } : {}) };
    const body = new FormData();
    body.set("model", model);
    body.set("prompt", prompt);
    body.set("seconds", String(seconds));
    if (size) body.set("size", size);
    body.set("input_reference", await newAPIImageFile(image), "reference-image");
    return body;
}

export function parseNewAPIVideoResponse(payload: unknown): VideoResponse {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("NewAPI 没有返回视频任务");
    const root = payload as Record<string, unknown>;
    if (typeof root.code === "number" && root.code !== 0) throw new Error(String(root.msg || root.message || "NewAPI 请求失败"));
    const task = (root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root) as VideoResponse;
    if (!task.id || typeof task.id !== "string") throw new Error(task.error?.message || "NewAPI 没有返回网关任务 ID");
    const states = ["queued", "pending", "processing", "in_progress", "completed", "failed", "cancelled", "canceled"];
    if (!task.status || !states.includes(task.status)) throw new Error(`NewAPI 返回未知视频状态：${task.status || "空"}`);
    // Never infer completion from a URL or replace the gateway ID with video_id.
    return { ...task, video_url: task.status === "completed" ? task.video_url : undefined, url: task.status === "completed" ? task.url : undefined };
}
