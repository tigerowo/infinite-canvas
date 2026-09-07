"use client";

import { useEffect } from "react";
import { useConfigStore } from "@/stores/use-config-store";
import { loadModelPolicy, useModelPolicy } from "./policy";

export function usePolicySync() {
    useEffect(() => {
        const unsubscribe = useModelPolicy.subscribe((state, previous) => {
            if (JSON.stringify(state.policy.overrides) === JSON.stringify(previous.policy.overrides)) return;
            useConfigStore.setState((value) => ({ config: { ...value.config } }));
        });
        const refresh = () => { void loadModelPolicy(true).catch(() => {}); };
        refresh();
        window.addEventListener("focus", refresh);
        const timer = window.setInterval(refresh, 60_000);
        return () => { unsubscribe(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
    }, []);
}
