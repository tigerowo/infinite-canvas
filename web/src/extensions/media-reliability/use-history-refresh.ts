"use client";
import { useEffect, useRef } from "react";

export function useHistoryRefresh(enabled: boolean, refresh: () => Promise<unknown>) {
    const latest = useRef(refresh);
    latest.current = refresh;
    useEffect(() => {
        if (!enabled) return;
        let busy = false;
        const run = async () => {
            if (busy || document.visibilityState === "hidden") return;
            busy = true;
            try { await latest.current(); } catch { /* Existing history UI exposes sync errors. */ }
            finally { busy = false; }
        };
        const timer = window.setInterval(() => void run(), 15000);
        window.addEventListener("focus", run);
        document.addEventListener("visibilitychange", run);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", run);
            document.removeEventListener("visibilitychange", run);
        };
    }, [enabled]);
}
