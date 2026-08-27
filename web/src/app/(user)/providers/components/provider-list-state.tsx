"use client";

import { Alert, Button, Empty, Skeleton, Tag, Tooltip } from "antd";
import { Check, CircleAlert, CircleDashed, Clock3, Plus, RefreshCw, ShieldCheck, Unplug, WifiOff } from "lucide-react";

import type { ProviderKind, ProviderStatus } from "@/lib/provider";

export type ProviderDisplayStatus = ProviderStatus | "testing";

const statusMeta: Record<ProviderDisplayStatus, { label: string; color: string; icon: typeof Check }> = {
    connected: { label: "已连接", color: "cyan", icon: Check },
    testing: { label: "测试中", color: "processing", icon: RefreshCw },
    failed: { label: "连接失败", color: "error", icon: CircleAlert },
    timeout: { label: "请求超时", color: "warning", icon: Clock3 },
    disabled: { label: "已禁用", color: "default", icon: Unplug },
    unavailable: { label: "不可用", color: "default", icon: WifiOff },
    untested: { label: "未测试", color: "warning", icon: CircleDashed },
};

export function ProviderSummary({ count, connectedCount, pending }: { count: number; connectedCount: number; pending: boolean }) {
    return (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <span className="inline-flex items-center gap-1.5">
                <span className="font-semibold text-stone-950 dark:text-stone-100">{pending ? "—" : count}</span>
                个连接
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${connectedCount ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-700"}`} />
                <span className="font-semibold text-stone-950 dark:text-stone-100">{pending ? "—" : connectedCount}</span>
                个已连接
            </span>
            <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" />
                SSRF 防护与响应限额已启用
            </span>
        </div>
    );
}

export function ProviderListState({ kind, loading, error, onCreate, onRetry }: { kind: ProviderKind; loading: boolean; error: string; onCreate: () => void; onRetry: () => void }) {
    if (error) {
        return <Alert className="mb-4" type="error" showIcon title="连接列表读取失败" description={error} action={<Button size="small" onClick={onRetry}>重试</Button>} />;
    }
    return (
        <section className="overflow-hidden rounded-lg lg:border lg:border-stone-200 lg:bg-background dark:lg:border-stone-800" aria-busy={loading}>
            {loading ? (
                <div className="rounded-lg border border-stone-200 bg-background p-6 lg:rounded-none lg:border-0 dark:border-stone-800">
                    <Skeleton active paragraph={{ rows: 5 }} />
                </div>
            ) : (
                <div className="rounded-lg border border-stone-200 bg-background lg:rounded-none lg:border-0 dark:border-stone-800">
                    <Empty className="py-16" image={Empty.PRESENTED_IMAGE_SIMPLE} description={kind === "api" ? "还没有 API 渠道" : "还没有 CLI 渠道"}>
                        <Button icon={<Plus className="size-4" />} onClick={onCreate}>
                            {kind === "api" ? "添加第一个 API" : "登记 CLI"}
                        </Button>
                    </Empty>
                </div>
            )}
        </section>
    );
}

export function ProviderStatusTag({ status, message }: { status: ProviderDisplayStatus; message?: string }) {
    const meta = statusMeta[status];
    const Icon = meta.icon;
    const tag = (
        <Tag color={meta.color} icon={<Icon className={`size-3 ${status === "testing" ? "motion-safe:animate-spin" : ""}`} />}>
            {meta.label}
        </Tag>
    );
    return message ? <Tooltip title={message}>{tag}</Tooltip> : tag;
}
