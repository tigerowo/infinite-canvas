"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CanvasDirectorCapture, CanvasDirectorPanorama, CanvasDirectorVideo } from "../types";

type PanoramaRemoval = Pick<CanvasDirectorPanorama, "edgeId" | "sourceNodeId">;
type DirectorCapturePayload = { dataUrl?: unknown; fileName?: unknown } | null | undefined;

export function CanvasDirector({
    nodeId,
    project,
    panoramas,
    theme,
    onClose,
    onProjectChange,
    onPanoramaRemoved,
    onCapturesSent,
    onVideoSent,
}: {
    nodeId: string;
    project: unknown;
    panoramas: CanvasDirectorPanorama[];
    theme: "light" | "dark";
    onClose: () => void;
    onProjectChange: (project: unknown) => void;
    onPanoramaRemoved: (payload: PanoramaRemoval) => void;
    onCapturesSent: (nodeId: string, captures: CanvasDirectorCapture[]) => void;
    onVideoSent: (nodeId: string, video: CanvasDirectorVideo) => void;
}) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const projectRef = useRef(project);
    const themeRef = useRef(theme);
    const sessionSentRef = useRef(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        projectRef.current = project;
    }, [project]);

    useEffect(() => {
        themeRef.current = theme;
    }, [theme]);

    const postToDesk = useCallback((type: string, payload: unknown) => {
        iframeRef.current?.contentWindow?.postMessage({ type, payload }, window.location.origin);
    }, []);

    useEffect(() => {
        function handleMessage(event: MessageEvent) {
            if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;

            const type = event.data?.type;
            if (type === "storyai:director-ready") {
                setReady(true);
                return;
            }

            if (type === "storyai:director-close") {
                onClose();
                return;
            }

            if (type === "storyai:director-project-changed") {
                const nextProject = event.data?.payload?.project;
                if (nextProject && typeof nextProject === "object" && !Array.isArray(nextProject)) onProjectChange(nextProject);
                return;
            }

            if (type === "storyai:director-panorama-removed") {
                const edgeId = typeof event.data?.payload?.edgeId === "string" ? event.data.payload.edgeId.trim() : "";
                const sourceNodeId = typeof event.data?.payload?.sourceNodeId === "string" ? event.data.payload.sourceNodeId.trim() : "";
                if (edgeId && sourceNodeId) onPanoramaRemoved({ edgeId, sourceNodeId });
                return;
            }

            if (type === "storyai:director-captures-sent") {
                const captures = Array.isArray(event.data?.payload?.captures)
                    ? event.data.payload.captures
                        .filter((capture: DirectorCapturePayload): capture is { dataUrl: string; fileName?: unknown } => typeof capture?.dataUrl === "string" && capture.dataUrl.startsWith("data:image/"))
                        .map((capture: { dataUrl: string; fileName?: unknown }, index: number) => ({ dataUrl: capture.dataUrl, fileName: typeof capture.fileName === "string" && capture.fileName.trim() ? capture.fileName.trim() : "导演台截图-" + (index + 1) + ".png" }))
                    : [];
                if (captures.length) void onCapturesSent(nodeId, captures);
                return;
            }

            if (type === "storyai:director-video-sent") {
                const blob = event.data?.payload?.blob;
                if (!(blob instanceof Blob) || !blob.size || !blob.type.startsWith("video/mp4")) return;
                const fileName = typeof event.data?.payload?.fileName === "string" && event.data.payload.fileName.trim()
                    ? event.data.payload.fileName.trim()
                    : "导演台视频.mp4";
                const width = Number(event.data?.payload?.width);
                const height = Number(event.data?.payload?.height);
                const durationSeconds = Number(event.data?.payload?.durationSeconds);
                void onVideoSent(nodeId, {
                    blob,
                    fileName,
                    width: Number.isFinite(width) && width > 0 ? width : 1280,
                    height: Number.isFinite(height) && height > 0 ? height : 720,
                    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
                });
                return;
            }
        }

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [nodeId, onCapturesSent, onClose, onPanoramaRemoved, onProjectChange, onVideoSent]);

    useEffect(() => {
        if (!ready || sessionSentRef.current) return;
        sessionSentRef.current = true;
        postToDesk("storyai:director-session", {
            instanceId: nodeId,
            theme: themeRef.current,
            project: projectRef.current,
        });
    }, [nodeId, postToDesk, ready]);

    useEffect(() => {
        if (!ready || !sessionSentRef.current) return;
        postToDesk("storyai:director-panoramas", { panoramas });
    }, [panoramas, postToDesk, ready]);

    return (
        <div className="fixed inset-0 z-[2000]">
            <iframe ref={iframeRef} title="3D导演台" src="/director/index.html" className="block h-full w-full border-0" />
        </div>
    );
}
