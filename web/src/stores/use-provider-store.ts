"use client";

import { create } from "zustand";

import { deleteProvider, detectCLIProvider, fetchProviders, migrateLegacyProviders, saveProvider, setDefaultProvider, testProvider } from "@/services/api/providers";
import type { CLIHelperResult, Provider, ProviderInput, ProviderMigrationResult } from "@/lib/provider";

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
        if (!force && get().loadedToken === token) return get().items;
        set({ loading: true, error: "" });
        try {
            const items = await fetchProviders(token);
            set({ items, loading: false, loadedToken: token });
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
        return item;
    },
    remove: async (token, id) => {
        await deleteProvider(token, id);
        set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
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
    migrate: async (token, cleanupLegacy) => {
        const result = await migrateLegacyProviders(token, cleanupLegacy);
        set({ items: result.providers, loadedToken: token, error: "" });
        return result;
    },
    clear: () => set({ items: [], loading: false, loadedToken: "", error: "" }),
}));
