import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

function detectImageFileType(bytes: Uint8Array) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mimeType: "image/jpeg", extension: ".jpg" };
    }
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return { mimeType: "image/png", extension: ".png" };
    }
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { mimeType: "image/webp", extension: ".webp" };
    }
    return null;
}

function imageFilename(name: string | undefined, extension: string) {
    const filename = name?.trim() || "reference";
    return `${filename.replace(/\.[^./\\]+$/, "") || "reference"}${extension}`;
}

export function dataUrlToFile(image: ReferenceImage) {
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    const detected = detectImageFileType(bytes);
    return new File([bytes], detected ? imageFilename(image.name, detected.extension) : image.name || "reference.png", { type: detected?.mimeType || mimeType });
}
