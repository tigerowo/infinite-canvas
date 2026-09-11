"use client";

import { useEffect } from "react";
import { App } from "antd";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import { useAssetStore } from "@/stores/use-asset-store";

export function useProjectSync() {
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const token = useUserStore((state) => state.token);
    const ready = useUserStore((state) => state.isReady);
    useEffect(() => {
        if (!ready || !user || !token) return;
        let disposed = false, running = false, configured = false, syncEnabled = false;
        let lastError = "";
        let unsubscribe = () => {};
        const active = () => !disposed && useUserStore.getState().token === token;
        const refresh = async () => {
            if (!active() || running || document.visibilityState === "hidden") return;
            running = true;
            try {
                const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                if (!active()) return;
                if (!configured) {
                    const config = await fetchUserConfig(token);
                    if (!active()) return;
                    syncEnabled = config.syncCapabilities?.userData === true;
                    useCanvasStore.getState().setSyncEnabled(syncEnabled);
                    unsubscribe = useCanvasStore.subscribe((next, previous) => {
                        if (next.syncError && next.syncError !== previous.syncError) message.error(`画布未同步：${next.syncError}`);
                    });
                    configured = true;
                }
                await useCanvasStore.getState().syncWithRemote(token, syncEnabled);
                if (!active()) return;
                await useAssetStore.getState().hydrateAccountAssets(token, syncEnabled);
                lastError = "";
            } catch (error) {
                const text = error instanceof Error ? error.message : "请检查网络";
                if (active() && text !== lastError) message.error(`账号数据同步暂不可用：${text}`);
                lastError = text;
            } finally { running = false; }
        };
        const refreshNow = () => { void refresh(); };
        const timer = window.setInterval(refreshNow, 5000);
        window.addEventListener("focus", refreshNow);
        window.addEventListener("online", refreshNow);
        document.addEventListener("visibilitychange", refreshNow);
        refreshNow();
        return () => {
            disposed = true;
            clearInterval(timer);
            window.removeEventListener("focus", refreshNow);
            window.removeEventListener("online", refreshNow);
            document.removeEventListener("visibilitychange", refreshNow);
            unsubscribe();
            useAssetStore.getState().stopAccountAssetSync();
        };
    }, [ready, user, token, message]);
}
