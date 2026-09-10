"use client";

import { Alert, Button, Collapse, Flex, Form, Input, Radio, Select, Typography } from "antd";
import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useUserStore } from "@/stores/use-user-store";
import type { AdminStorageProvider } from "@/services/api/admin";
import { loadStorageAccess, saveStorageAccessBatch, type StorageAccessConfig } from "./api";
import { corsRule, corsXML } from "./cors";
import { storageAccessProviderKey, validateStorageAccess } from "./draft";

export { storageAccessProviderKey } from "./draft";
export type StorageAccessProviderOption = AdminStorageProvider & { clientKey: string; draftIndex: number };
export type StorageAccessPanelHandle = {
    validateDraft: () => Promise<void>;
    saveDraft: (providers: StorageAccessProviderOption[]) => Promise<void>;
    reload: () => Promise<void>;
};

const emptyConfig: StorageAccessConfig = { allowedOrigins: [], delivery: "s3", cdnBaseUrl: "", tokenKey: "", hasTokenKey: false };
const AccessContext = createContext<{
    ready: boolean;
    loading: boolean;
    error: string;
    get: (provider: AdminStorageProvider) => StorageAccessConfig;
    update: (provider: AdminStorageProvider, patch: Partial<StorageAccessConfig>) => void;
} | null>(null);

// Keep drafts mounted across visual/JSON and public/private tab changes.
export const StorageAccessPanel = forwardRef<StorageAccessPanelHandle, {
    providers: StorageAccessProviderOption[];
    enabled: boolean;
    children: ReactNode;
}>(function StorageAccessPanel({ providers, enabled, children }, ref) {
    const token = useUserStore((state) => state.token);
    const [drafts, setDrafts] = useState<Record<string, StorageAccessConfig>>({});
    const [loading, setLoading] = useState(false);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const startedFor = useRef("");
    const load = useCallback(async () => {
        if (!token) return;
        setReady(false);
        setLoading(true);
        try {
            const loaded = await loadStorageAccess(token);
            setDrafts(Object.fromEntries(loaded.map((item) => [item.id, { ...emptyConfig, ...item.config }])));
            setError("");
            setReady(true);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "读取存储访问设置失败");
        } finally { setLoading(false); }
    }, [token]);
    useEffect(() => {
        if (!enabled || !token || startedFor.current === token) return;
        startedFor.current = token;
        void load();
    }, [enabled, token, load]);

    const get = (provider: AdminStorageProvider) => ({ ...emptyConfig, ...(drafts[storageAccessProviderKey(provider)] || drafts[provider.id]) });
    const update = (provider: AdminStorageProvider, patch: Partial<StorageAccessConfig>) => {
        const key = storageAccessProviderKey(provider);
        setDrafts((current) => ({
            ...Object.fromEntries(Object.entries(current).map(([id, value]) => [id, patch.defaultUpload ? { ...value, defaultUpload: false } : value])),
            [key]: { ...emptyConfig, ...(current[key] || current[provider.id]), ...patch },
        }));
    };
    useImperativeHandle(ref, () => ({
        validateDraft: async () => {
            if (!startedFor.current) return;
            if (!ready) throw new Error("存储访问设置尚未加载完成，请刷新后再保存");
            providers.filter((item) => item.type === "s3").forEach((item) => validateStorageAccess(item, get(item)));
        },
        saveDraft: async (nextProviders) => {
            if (!startedFor.current) return;
            if (!token || !ready) throw new Error("存储访问设置尚未加载完成，请刷新后再保存");
            const s3 = nextProviders.filter((item) => item.type === "s3" && item.id);
            const inputs = s3.map((item) => {
                const config = get(item);
                validateStorageAccess(item, config);
                return { providerId: item.id, ...config };
            });
            setLoading(true);
            try {
                const saved = await saveStorageAccessBatch(token, inputs);
                setDrafts(Object.fromEntries(saved.flatMap((item) => {
                    const key = s3.find((provider) => provider.id === item.id)?.clientKey || item.id;
                    const config = { ...emptyConfig, ...item.config };
                    return [[item.id, config], [key, config]];
                })));
            } finally { setLoading(false); }
        },
        reload: load,
    }));
    return <AccessContext.Provider value={{ ready, loading, error, get, update }}>{children}</AccessContext.Provider>;
});

export function StorageAccessFields({ provider }: { provider: AdminStorageProvider }) {
    const access = useContext(AccessContext);
    if (!access) return null;
    if (access.error) return <Alert type="error" showIcon title={access.error} />;
    const config = access.get(provider);
    const update = (patch: Partial<StorageAccessConfig>) => access.update(provider, patch);
    const preview = JSON.stringify(corsRule(config.allowedOrigins), null, 2);
    return (
        <fieldset disabled={!access.ready || access.loading} className="min-w-0 border-0 border-t border-solid border-[var(--glass-border)] pt-4">
            <legend className="px-2 text-sm font-medium">文件访问与跨域</legend>
            <Flex vertical gap={12}>
                <Radio checked={Boolean(config.defaultUpload)} disabled={!provider.enabled || provider.capacityExceeded || !access.ready || access.loading} onChange={() => update({ defaultUpload: true })}>默认上传位置</Radio>
                <Form.Item label="文件读取方式" className="!mb-0">
                    <Select disabled={!access.ready || access.loading} aria-label="文件读取方式" value={config.delivery} onChange={(delivery) => update({ delivery })} options={[{ value: "s3", label: "签名直读" }, { value: "edgeone-b", label: "腾讯 EdgeOne（Type B）" }, { value: "esa-a", label: "阿里 ESA（Type A）" }]} />
                </Form.Item>
                {config.delivery !== "s3" ? <>
                    <Form.Item label="CDN 域名" className="!mb-0"><Input value={config.cdnBaseUrl} placeholder="https://media.example.com" aria-label="CDN 域名" onChange={(event) => update({ cdnBaseUrl: event.target.value })} /></Form.Item>
                    <Form.Item label={config.delivery === "esa-a" ? "ESA Type A 密钥" : "EdgeOne Type B 密钥"} className="!mb-0" extra="边缘端鉴权有效期：300 秒"><Input.Password value={config.tokenKey} autoComplete="new-password" placeholder={config.hasTokenKey ? "已保存，留空沿用" : "填写对应的鉴权密钥"} aria-label="CDN 鉴权密钥" onChange={(event) => update({ tokenKey: event.target.value })} /></Form.Item>
                </> : null}
                <Form.Item label="CORS 允许来源" className="!mb-0" extra="每行填写一个画布站点来源，不含路径或通配符。规则需在存储或 CDN 控制台应用。">
                    <Input.TextArea rows={3} value={config.allowedOrigins.join("\n")} aria-label="CORS 允许来源" placeholder="https://canvas.example.com" onChange={(event) => update({ allowedOrigins: event.target.value.split(/\r?\n/) })} />
                </Form.Item>
                <Button className="self-start" onClick={() => update({ allowedOrigins: [...new Set([...config.allowedOrigins.filter(Boolean), window.location.origin])] })}>加入当前画布站点</Button>
                <Collapse items={[{ key: "cors", label: "CORS 规则预览", children: config.allowedOrigins.some((value) => value.trim()) ? <Flex vertical gap={8}><Typography.Paragraph copyable={{ text: preview }}>S3 JSON</Typography.Paragraph><Typography.Paragraph copyable={{ text: corsXML(config.allowedOrigins) }}>S3 XML</Typography.Paragraph><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 300, overflow: "auto" }}>{preview}</pre></Flex> : <Typography.Text type="secondary">尚未填写允许来源</Typography.Text> }]} />
            </Flex>
        </fieldset>
    );
}
