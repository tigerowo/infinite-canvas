export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

export const grokVoiceOptions = [
    { value: "ara", label: "Ara" },
    { value: "eve", label: "Eve" },
    { value: "sal", label: "Sal" },
    { value: "rex", label: "Rex" },
    { value: "leo", label: "Leo" },
    { value: "sia", label: "Sia" },
];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeGrokVoiceValue(value: string) {
    const voice = value.trim().toLowerCase();
    if (grokVoiceOptions.some((item) => item.value === voice)) return voice;
    // OpenAI voice names can still be mapped by grok2api; keep them selectable only as fallback labels.
    const mapped: Record<string, string> = {
        alloy: "ara",
        verse: "ara",
        echo: "eve",
        ballad: "eve",
        fable: "sal",
        coral: "sal",
        onyx: "rex",
        ash: "rex",
        nova: "leo",
        sage: "leo",
        shimmer: "sia",
        marin: "sia",
    };
    return mapped[voice] || "ara";
}

export function isGrokVoiceModel(model: string) {
    return model.trim().toLowerCase().startsWith("grok-voice-");
}

export function isGrok2APIFamilyChannel(channel?: { protocol?: string; baseUrl?: string } | null) {
    const protocol = channel?.protocol?.trim().toLowerCase() || "";
    const baseUrl = channel?.baseUrl?.trim().toLowerCase() || "";
    return protocol === "grok2api" || protocol === "xai" || baseUrl.includes("grok2api") || baseUrl.includes("api.x.ai") || baseUrl.includes("x.ai/");
}

export function shouldUseGrokVoiceOptions(model: string, channel?: { protocol?: string; baseUrl?: string } | null) {
    if (isGrokVoiceModel(model)) return true;
    if (!isGrok2APIFamilyChannel(channel)) return false;
    const name = model.trim().toLowerCase();
    // Grok/xAI channel: only switch voice catalog for voice/tts-like models, not chat/image/video.
    return !name || name.includes("grok") || name.includes("voice") || name.includes("tts") || name.includes("speech");
}

export function audioVoiceOptionsFor(model: string, channel?: { protocol?: string; baseUrl?: string } | null) {
    return shouldUseGrokVoiceOptions(model, channel) ? grokVoiceOptions : audioVoiceOptions;
}

export function normalizeAudioVoiceValueFor(model: string, value: string, channel?: { protocol?: string; baseUrl?: string } | null) {
    return shouldUseGrokVoiceOptions(model, channel) ? normalizeGrokVoiceValue(value) : normalizeAudioVoiceValue(value);
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    return audioVoiceLabelFor("", value);
}

export function audioVoiceLabelFor(model: string, value: string, channel?: { protocol?: string; baseUrl?: string } | null) {
    const voice = normalizeAudioVoiceValueFor(model, value, channel);
    const options = audioVoiceOptionsFor(model, channel);
    return options.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
