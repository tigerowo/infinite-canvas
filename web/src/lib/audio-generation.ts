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

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export const glmTtsVoiceOptions = [
    { value: "tongtong", label: "彤彤" },
    { value: "chuichui", label: "锤锤" },
    { value: "xiaochen", label: "小陈" },
    { value: "jam", label: "Jam" },
    { value: "kazi", label: "Kazi" },
    { value: "douji", label: "Douji" },
    { value: "luodo", label: "Luodo" },
];

export const glmTtsFormatOptions = [
    { value: "wav", label: "WAV" },
    { value: "pcm", label: "PCM" },
];

export function isGlmTtsModel(model: string) {
    return model.trim().toLowerCase() === "glm-tts";
}

export function normalizeGlmTtsVoice(value: string) {
    return glmTtsVoiceOptions.some((item) => item.value === value) ? value : "tongtong";
}

export function normalizeGlmTtsFormat(value: string) {
    return glmTtsFormatOptions.some((item) => item.value === value) ? value : "wav";
}

export function normalizeGlmTtsSpeed(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.5, Math.min(2, Number(speed.toFixed(2)))));
}

export function glmTtsVoiceLabel(value: string) {
    const voice = normalizeGlmTtsVoice(value);
    return glmTtsVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
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
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
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
