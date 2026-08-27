"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { App } from "antd";

import { fetchUserConfig } from "@/services/api/user-config";
import { defaultUserStorageProvider, defaultUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider } from "@/services/image-storage";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { syncProviderCatalog, useProviderStore } from "@/stores/use-provider-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const channelMode = useConfigStore((state) => state.config.channelMode);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";
    const adminRemoteTokenRef = useRef("");

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        if (isLoginPage) return;

        if (useUserStore.persist.hasHydrated()) {
            void hydrateUser();
            return;
        }

        let unsubscribe = () => {};
        unsubscribe = useUserStore.persist.onFinishHydration(() => {
            unsubscribe();
            void hydrateUser();
        });
        if (useUserStore.persist.hasHydrated()) {
            unsubscribe();
            void hydrateUser();
        }
        return unsubscribe;
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        if (!token || user?.role !== "admin" || adminRemoteTokenRef.current === token) return;
        adminRemoteTokenRef.current = token;
        if (channelMode !== "remote") updateConfig("channelMode", "remote");
    }, [channelMode, token, updateConfig, user?.role]);

    useEffect(() => {
        if (!token || !user?.id) {
            useProviderStore.getState().clear();
            return;
        }
        void Promise.all([fetchUserConfig(token), useProviderStore.getState().load(token).catch(() => [])])
            .then(([payload, providers]) => {
                const syncS3 = payload.modelConfig?.syncStorageConfig === true;
                const syncWebDAV = payload.modelConfig?.syncWebDAVStorageConfig === true;
                if (payload.modelConfig) {
                    Object.entries(payload.modelConfig)
                        .forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                }
                syncProviderCatalog(providers);
                updateConfig("syncStorageConfig", syncS3);
                updateConfig("syncWebDAVStorageConfig", syncWebDAV);
                if (syncS3 && payload.storageProvider?.s3) {
                    saveUserStorageProvider({
                        ...defaultUserStorageProvider(),
                        ...payload.storageProvider.s3,
                        type: "s3",
                    });
                }
                if (syncWebDAV && payload.storageProvider?.webdav) {
                    saveUserWebDAVStorageProvider({
                        ...defaultUserWebDAVStorageProvider(),
                        ...payload.storageProvider.webdav,
                        type: "webdav",
                    });
                }
            })
            .catch(() => {});
    }, [token, updateConfig, user?.id]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        if (!publicSettings) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        if (!publicSettings.modelChannel.allowCustomChannel) {
            openConfigDialog(false);
            message.error("后台未允许用户自定义渠道，请联系管理员进行配置");
            return;
        }
        updateConfig("channelMode", "local");
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
    }, [message, openConfigDialog, publicSettings, updateConfig]);

    return <>{children}</>;
}
