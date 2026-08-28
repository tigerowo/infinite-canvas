"use client";

import { create } from "zustand";

import { cancelCLIModelProbe, checkCLIProviderAuth, deleteProvider, detectCLIProvider, fetchProviders, migrateLegacyProviders, queryCLIModelProbe, saveProvider, setDefaultProvider, startCLIModelProbe, startCLIProviderLogin, testProvider } from "@/services/api/providers";
import { providerModelChannels, type CLIHelperResult, type Provider, type ProviderCapability, type ProviderInput, type ProviderMigrationResult } from "@/lib/provider";
import { useConfigStore, type AiConfig, type LocalModelChannel } from "@/stores/use-config-store";

type ProviderStore = {
    items: Provider[];
    loading: boolean;
    loadedToken: string;
    error: string;
    load: (token: string, force?: boolean) => Promise<Provider[]>;
    save: (token: string, input: ProviderInput) => Promise<Provider>;
    remove: (token: string, id: string) => Promise<void>;
    setDefault: (token: string, id: string) => Promise<Provider>;
    test: (token: string, id: string, refreshModels?: boolean) => Promise<void>;
    detectCLI: (token: string, id: string) => Promise<CLIHelperResult>;
    checkCLIAuth: (token: string, id: string) => Promise<CLIHelperResult>;
    startCLILogin: (token: string, id: string) => Promise<CLIHelperResult>;
    startCLIProbe: (token: string, id: string) => Promise<CLIHelperResult>;
    queryCLIProbe: (token: string, id: string, taskId: string) => Promise<CLIHelperResult>;
    cancelCLIProbe: (token: string, id: string, taskId: string) => Promise<CLIHelperResult>;
    migrate: (token: string, cleanupLegacy: boolean) => Promise<ProviderMigrationResult>;
    clear: () => void;
};

export const useProviderStore = create<ProviderStore>((set, get) => ({
    items: [],
    loading: false,
    loadedToken: "",
    error: "",
    load: async (token, force = false) => {
        if (!token) return [];
        if (!force && get().loadedToken === token) {
            syncProviderCatalog(get().items);
            return get().items;
        }
        set({ loading: true, error: "" });
        try {
            const items = await fetchProviders(token);
            set({ items, loading: false, loadedToken: token });
            syncProviderCatalog(items);
            return items;
        } catch (error) {
            set({ loading: false, error: error instanceof Error ? error.message : "读取连接失败" });
            throw error;
        }
    },
    save: async (token, input) => {
        const item = await saveProvider(token, input);
        set((state) => ({ items: state.items.some((current) => current.id === item.id) ? state.items.map((current) => (current.id === item.id ? item : current)) : [...state.items, item] }));
        if (item.isDefault) await get().load(token, true);
        else syncProviderCatalog(get().items);
        return item;
    },
    remove: async (token, id) => {
        await deleteProvider(token, id);
        set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
        syncProviderCatalog(get().items);
    },
    setDefault: async (token, id) => {
        const item = await setDefaultProvider(token, id);
        await get().load(token, true);
        return item;
    },
    test: async (token, id, refreshModels = false) => {
        try {
            await testProvider(token, id, refreshModels);
        } finally {
            await get().load(token, true);
        }
    },
    detectCLI: async (token, id) => {
        try {
            return await detectCLIProvider(token, id);
        } finally {
            await get().load(token, true);
        }
    },
    checkCLIAuth: async (token, id) => {
        try {
            return await checkCLIProviderAuth(token, id);
        } finally {
            await get().load(token, true);
        }
    },
    startCLILogin: (token, id) => startCLIProviderLogin(token, id),
    startCLIProbe: (token, id) => startCLIModelProbe(token, id),
    queryCLIProbe: (token, id, taskId) => queryCLIModelProbe(token, id, taskId),
    cancelCLIProbe: (token, id, taskId) => cancelCLIModelProbe(token, id, taskId),
    migrate: async (token, cleanupLegacy) => {
        const result = await migrateLegacyProviders(token, cleanupLegacy);
        set({ items: result.providers, loadedToken: token, error: "" });
        syncProviderCatalog(result.providers);
        return result;
    },
    clear: () => {
        set({ items: [], loading: false, loadedToken: "", error: "" });
        syncProviderCatalog([]);
    },
}));

export function syncProviderCatalog(providers: Provider[]) {
    const configStore = useConfigStore.getState();
    const current = configStore.config.localChannels;
    const managed: LocalModelChannel[] = providerModelChannels(providers);
    const legacy = current.filter((channel) => !channel.managed);
    const next = [...legacy, ...managed];
    if (JSON.stringify(next) !== JSON.stringify(current)) configStore.updateConfig("localChannels", next);

    const fields: Array<[keyof Pick<AiConfig, "imageChannelId" | "videoChannelId" | "textChannelId" | "audioChannelId">, ProviderCapability]> = [
        ["imageChannelId", "image"],
        ["videoChannelId", "video"],
        ["textChannelId", "text"],
        ["audioChannelId", "audio"],
    ];
    for (const [field, capability] of fields) {
        if (managed.some((channel) => channel.id === configStore.config[field] && channel.enabled !== false && channel.capabilities?.includes(capability))) continue;
        const preferred = managed.find((channel) => channel.enabled !== false && channel.isDefault && channel.capabilities?.includes(capability)) || managed.find((channel) => channel.enabled !== false && channel.capabilities?.includes(capability));
        if (preferred) configStore.updateConfig(field, preferred.id);
    }
}
