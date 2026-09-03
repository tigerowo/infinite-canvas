import { channelProtocolForConfig, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";

export const GEMINI_PROTOCOL = "gemini" as const;
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export function isGeminiConfig(config: AiConfig, model = config.model) {
    return channelProtocolForConfig({ ...config, model }) === GEMINI_PROTOCOL;
}

export function isGeminiVideoModel(model: string) {
    return /^models\/veo-|^veo-/i.test(model.trim());
}

export function isGeminiTtsModel(model: string) {
    return model.trim().toLowerCase().includes("tts");
}

export function normalizeGeminiModel(model: string) {
    return model.trim().replace(/^models\//i, "");
}

export function normalizeGeminiBaseUrl(baseUrl: string) {
    return (baseUrl.trim() || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1beta$/i, "");
}

export function geminiActionUrl(baseUrl: string, model: string, action: "generateContent" | "streamGenerateContent" | "predictLongRunning") {
    const suffix = action === "streamGenerateContent" ? ":streamGenerateContent?alt=sse" : `:${action}`;
    return `${normalizeGeminiBaseUrl(baseUrl)}/v1beta/models/${encodeURIComponent(normalizeGeminiModel(model))}${suffix}`;
}

export function geminiOperationUrl(baseUrl: string, operation: string) {
    const name = operation
        .trim()
        .replace(/^\/+/, "")
        .replace(/^v1beta\//i, "");
    return `${normalizeGeminiBaseUrl(baseUrl)}/v1beta/${name}`;
}

export function geminiDirectHeaders(config: AiConfig) {
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": localChannelForActiveModel(config)?.apiKey || config.apiKey,
    };
}

export function dataUrlToGeminiInlineData(dataUrl: string) {
    const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (!match) throw new Error("Gemini 素材必须是 Base64 图片数据");
    return { inlineData: { mimeType: match[1], data: match[2] } };
}

export function geminiErrorMessage(payload: unknown, fallback: string) {
    const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : {};
    const feedback = root.promptFeedback && typeof root.promptFeedback === "object" ? (root.promptFeedback as Record<string, unknown>) : {};
    const candidates = Array.isArray(root.candidates) ? (root.candidates as Array<Record<string, unknown>>) : [];
    return firstText(error.message, feedback.blockReason, ...candidates.map((item) => item.finishReason), fallback);
}

function firstText(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";
}
