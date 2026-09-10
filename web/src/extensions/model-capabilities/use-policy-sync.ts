"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useConfigStore } from "@/stores/use-config-store";
import { loadModelPolicy, useModelPolicy } from "./policy";

export function usePolicySync() {
    const pathname = usePathname();
    useEffect(() => {
        // Admin settings owns this extension's private editor and loads it only
        // after the private visual tab is opened. User-facing workspaces still
        // use this public, redacted policy cache for capability selection.
        if (pathname === "/login" || pathname === "/admin/login" || pathname?.startsWith("/admin")) return;
        const unsubscribe = useModelPolicy.subscribe((state, previous) => {
            if (JSON.stringify(state.policy.overrides) === JSON.stringify(previous.policy.overrides)) return;
            useConfigStore.setState((value) => ({ config: { ...value.config } }));
        });
        const refresh = () => { void loadModelPolicy(true).catch(() => {}); };
        refresh();
        window.addEventListener("focus", refresh);
        const timer = window.setInterval(refresh, 60_000);
        return () => { unsubscribe(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
    }, [pathname]);
}
