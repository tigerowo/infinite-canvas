import type { CanvasAgentToolResult } from "@/app/(user)/canvas/agent/canvas-agent-tools";
import type { CanvasAgentContent } from "@/app/(user)/canvas/types";
import { requestCanvasVideoVision } from "@/services/api/canvas-agent";
import { refreshRemoteUser } from "@/services/api/image";
import { downloadRemoteMedia, resolveMediaUrl } from "@/services/file-storage";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type VideoAnalysisSession = { id: string; durationMs: number };
type VideoAnalysisFrame = { timestampMs: number; jpeg: string; digest: string };
type VideoAnalysisFrames = { frames: VideoAnalysisFrame[]; nextMs: number | null; lastFrameUs: number | null };

type VideoAnalysisInput = {
    config: AiConfig;
    signal: AbortSignal;
    token: string;
    nodeId: string;
    source: string;
    storageKey?: string;
    question: string;
    detailed?: boolean;
    startMs?: number;
    endMs?: number;
};

async function requestVideoAnalysis<T>(token: string, suffix: string, init: RequestInit): Promise<{ data: T; status: number; message: string }> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer " + token);
    headers.set("X-Canvas-Node-Request", "true");
    const response = await fetch("/api/v1/canvas/video-analysis" + suffix, { ...init, headers });
    const payload = await response.json().catch(() => ({ code: 1 }));
    return {
        data: payload.data as T,
        status: response.ok && payload.code === 0 ? 200 : response.ok ? 500 : response.status,
        message: payload.msg || "视频分析请求失败",
    };
}

export async function analyzeCanvasVideo(input: VideoAnalysisInput): Promise<CanvasAgentToolResult> {
    const { token, signal, question, nodeId, detailed = false } = input;
    const browserStorage = input.storageKey?.startsWith("server:webdav:") ||
        input.source.includes("direct=1") || input.source.startsWith("/webdav-media/");
    const source = !browserStorage && (/^https?:\/\//i.test(input.source) || input.source.startsWith("/api/files/"))
        ? input.source
        : await resolveMediaUrl(input.storageKey, input.source);
    signal.throwIfAborted();
    if (!source) throw new Error("找不到原视频，请重新添加素材");

    const url = new URL(source, window.location.href);
    const form = new FormData();
    const remote = url.protocol === "https:" || url.protocol === "http:";
    const useURL = remote && !(browserStorage && url.origin === window.location.origin &&
        (url.searchParams.get("direct") === "1" || url.pathname.startsWith("/webdav-media/")));
    let session: VideoAnalysisSession | undefined;
    let sentFrames = 0;

    try {
        if (useURL) {
            form.set("url", url.origin === window.location.origin && !url.search && /^\/api\/files\/[\w-]+\/content$/.test(url.pathname)
                ? url.pathname : url.href);
        } else {
            if (!remote && url.protocol !== "blob:") throw new Error("视频地址无效");
            form.set("file", await downloadRemoteMedia(source, { signal, direct: true }), "video");
        }

        let response = await requestVideoAnalysis<VideoAnalysisSession>(token, "", { method: "POST", body: form, signal });
        if (useURL && response.status === 424) {
            form.delete("url");
            form.set("file", await downloadRemoteMedia(source, { signal, direct: true }), "video");
            response = await requestVideoAnalysis<VideoAnalysisSession>(token, "", { method: "POST", body: form, signal });
        }
        if (response.status !== 200) throw new Error(response.message);
        session = response.data;
        form.delete("file");
        const analysisId = session.id;
        const path = "/" + encodeURIComponent(analysisId);
        const durationMs = session.durationMs;
        const startMs = input.startMs ?? 0;
        const endMs = Math.min(input.endMs ?? durationMs, durationMs);
        if (startMs >= endMs) throw new Error("所选区间不在视频范围内");

        const observed: Array<{ startMs: number; endMs: number; text: string }> = [];
        const reviews: Array<{ startMs: number; endMs: number }> = [];
        const seen = new Map<string, number>();
        const sampledTimes = new Set<number>();
        let repeatedFrames = 0;
        let windowsWithoutFrames = 0;

        const analyzeRanges = async (ranges: typeof reviews, original: boolean, canReview: boolean) => {
            if (!ranges.length) return;
            const from = ranges[0].startMs;
            const to = ranges[ranges.length - 1].endMs;
            const collected: VideoAnalysisFrame[] = [];
            let previousFrameUs: number | null = null;
            let extractionFailure: { cause: unknown } | undefined;
            try {
                for (let rangeIndex = 0, cursor = from; rangeIndex < ranges.length;) {
                    signal.throwIfAborted();
                    const rangeEnd = ranges[rangeIndex].endMs;
                    const until = Math.min(rangeEnd, cursor + (original ? 250 : 4_000));
                    const batch = await requestVideoAnalysis<VideoAnalysisFrames>(token, path + "/frames", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ startMs: cursor, endMs: until, original, detailed, previousFrameUs }),
                        signal,
                    });
                    if (batch.status !== 200) throw new Error(batch.message);
                    previousFrameUs = batch.data.lastFrameUs ?? previousFrameUs;

                    if (!batch.data.frames.length && canReview) windowsWithoutFrames += 1;
                    const repeats: Array<{ timestampMs: number; sameAsMs: number }> = [];
                    const frames = batch.data.frames.filter((frame) => {
                        const newTime = !sampledTimes.has(frame.timestampMs);
                        sampledTimes.add(frame.timestampMs);
                        const sameAsMs = seen.get(frame.digest);
                        if (sameAsMs !== undefined) {
                            if (newTime) repeats.push({ timestampMs: frame.timestampMs, sameAsMs });
                            return false;
                        }
                        seen.set(frame.digest, frame.timestampMs);
                        return true;
                    });
                    if (repeats.length) {
                        observed.push({
                            startMs: repeats[0].timestampMs,
                            endMs: repeats[repeats.length - 1].timestampMs,
                            text: repeats.map(({ timestampMs, sameAsMs }) => `${timestampMs} 毫秒与 ${sameAsMs} 毫秒画面相同`).join("。"),
                        });
                        repeatedFrames += repeats.length;
                    }

                    collected.push(...frames);
                    const next = batch.data.nextMs ?? until;
                    if (next <= cursor || next > until) throw new Error("视频取帧进度异常");
                    cursor = next;
                    if (cursor === rangeEnd) {
                        rangeIndex++;
                        cursor = ranges[rangeIndex]?.startMs ?? cursor;
                        previousFrameUs = null;
                    }
                }
            } catch (cause) {
                if (signal.aborted || !collected.length) throw cause;
                extractionFailure = { cause };
            }

            const framesPerBatch = 90;
            for (let index = 0; index < collected.length; index += framesPerBatch) {
                signal.throwIfAborted();
                const group = collected.slice(index, index + framesPerBatch);
                const start = index === 0 ? from : group[0].timestampMs;
                const end = collected[index + framesPerBatch]?.timestampMs ?? to;
                const sampledFromMs = group[0].timestampMs;
                const sampledToMs = group[group.length - 1].timestampMs;
                const content: CanvasAgentContent = [{
                    type: "text",
                    text: JSON.stringify({
                        question, canReview, sampledFromMs, sampledToMs,
                        reviewWindow: ranges.length === 1 ? { startMs: start, endMs: end } : undefined,
                    }),
                }];
                for (const frame of group) {
                    content.push(
                        { type: "text", text: `视频时间 ${frame.timestampMs} 毫秒` },
                        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + frame.jpeg } },
                    );
                }

                const answer = await requestCanvasVideoVision(input.config, content, analysisId, signal);
                sentFrames += group.length;
                let text = answer;
                try {
                    const clean = answer.replace(/^```(?:json)?\s*|\s*```$/gi, "");
                    const result = JSON.parse(clean) || {};
                    if (typeof result.text === "string" && result.text.trim()) text = result.text.trim();
                    if (canReview) {
                        const requested = Array.isArray(result.reviews) ? result.reviews : [result.review];
                        for (const review of requested) {
                            if (!Number.isSafeInteger(review?.startMs) || !Number.isSafeInteger(review?.endMs)) continue;
                            const reviewStartMs = Math.max(start, review.startMs);
                            const reviewEndMs = Math.min(end, review.endMs);
                            if (reviewStartMs < reviewEndMs && reviewEndMs - reviewStartMs <= 1_000) {
                                reviews.push({ startMs: reviewStartMs, endMs: reviewEndMs });
                            }
                        }
                    }
                } catch (error) {
                    if (!(error instanceof SyntaxError)) throw error;
                }
                observed.push({ startMs: sampledFromMs, endMs: sampledToMs, text });
            }
            if (extractionFailure) throw extractionFailure.cause;
        };

        try {
            const original = input.startMs !== undefined && endMs - startMs <= 250;
            await analyzeRanges([{ startMs, endMs }], original, !original);

            const merged: typeof reviews = [];
            for (const range of reviews.sort((a, b) => a.startMs - b.startMs)) {
                const previous = merged.at(-1);
                if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
                else merged.push(range);
            }
            await analyzeRanges(merged, true, false);
        } catch (error) {
            if (signal.aborted || !sentFrames) throw error;
            return {
                ok: false, code: "video_analysis_partial", nodeId, sentFrames,
                observed: observed.sort((a, b) => a.startMs - b.startMs),
                message: error instanceof Error ? error.message : "后续视频区间分析失败",
            };
        }

        if (!sentFrames) throw new Error("所选区间没有可分析的视频帧");
        return {
            ok: true, nodeId, requestedRange: { startMs, endMs }, sentFrames,
            sampledFrames: sampledTimes.size, windowsWithoutFrames, repeatedFrames,
            observed: observed.sort((a, b) => a.startMs - b.startMs),
        };
    } finally {
        if (session) {
            await requestVideoAnalysis(token, "/" + encodeURIComponent(session.id), {
                method: "DELETE",
                signal: AbortSignal.timeout(5_000),
            }).catch(() => {});
        }
        if (sentFrames > 0 && useUserStore.getState().token === token) refreshRemoteUser(input.config);
    }
}
