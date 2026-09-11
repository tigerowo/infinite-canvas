export const REFERENCE_LIMIT = 50;

export type MediaReferenceInput = {
    references?: readonly unknown[];
    videoReferences?: readonly unknown[];
    audioReferences?: readonly unknown[];
    firstFrame?: unknown;
    lastFrame?: unknown;
};

export function countMediaReferences(input: MediaReferenceInput, elements: readonly { references?: readonly unknown[] }[] = []) {
    return (input.references?.length || 0) + (input.videoReferences?.length || 0) + (input.audioReferences?.length || 0)
        + Number(Boolean(input.firstFrame)) + Number(Boolean(input.lastFrame))
        + elements.reduce((count, item) => count + (item.references?.length || 0), 0);
}

export function referenceLimitError(count: number) {
    return count > REFERENCE_LIMIT ? `图片、视频、音频参考素材合计最多 ${REFERENCE_LIMIT} 个，当前 ${count} 个，请移除多余素材后重试` : "";
}

export function assertReferenceLimit(count: number) {
    const error = referenceLimitError(count);
    if (error) throw new Error(error);
}
