"use client";

import { Alert, Button, Empty, Skeleton, Tooltip } from "antd";
import { Plus, RefreshCw, ShieldCheck } from "lucide-react";

import type { ProviderKind, ProviderStatus } from "@/lib/provider";

export type ProviderDisplayStatus = ProviderStatus | "testing";

const statusMeta: Record<ProviderDisplayStatus, { label: string; dot: string; text: string }> = {
    connected: { label: "已连接", dot: "bg-[#00a1c2] dark:bg-[#00cae0]", text: "text-[#00a1c2] dark:text-[#00cae0]" },
    testing: { label: "测试中", dot: "bg-[#00a1c2] dark:bg-[#00cae0]", text: "text-[#00a1c2] dark:text-[#00cae0]" },
    failed: { label: "连接失败", dot: "bg-[#ff3355]", text: "text-[#d80f34] dark:text-[#ff3355]" },
    timeout: { label: "请求超时", dot: "bg-[#ffa21e]", text: "text-[#a85f00] dark:text-[#ffa21e]" },
    disabled: { label: "已禁用", dot: "bg-black/35 dark:bg-white/35", text: "text-black/50 dark:text-white/50" },
    unavailable: { label: "不可用", dot: "bg-[#ff3355]", text: "text-[#d80f34] dark:text-[#ff3355]" },
    untested: { label: "未测试", dot: "bg-[#ffa21e]", text: "text-[#a85f00] dark:text-[#ffa21e]" },
};

export function ProviderSummary({ count, connectedCount, pending }: { count: number; connectedCount: number; pending: boolean }) {
    return (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-0 bg-transparent px-0 py-0 text-center text-xs text-black/60 md:justify-start md:rounded-lg md:border md:border-black/10 md:bg-white md:px-4 md:py-2 md:text-left dark:md:border-white/[0.06] dark:md:bg-[#1a2122] dark:text-[rgba(224,245,255,0.60)]">
            <span className="inline-flex items-center gap-1.5">
                <span className="font-semibold text-[#0f1419] dark:text-[#f5fbff]">{pending ? "—" : count}</span>
                个连接
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${connectedCount ? "bg-[#00a1c2] dark:bg-[#00cae0]" : "bg-black/20 dark:bg-white/20"}`} />
                <span className="font-semibold text-[#0f1419] dark:text-[#f5fbff]">{pending ? "—" : connectedCount}</span>
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
        <section className="overflow-hidden rounded-[12px] lg:border lg:border-black/10 lg:bg-white dark:lg:border-white/[0.06] dark:lg:bg-[#0e1416]" aria-busy={loading}>
            {loading ? (
                <div className="rounded-[12px] border border-black/10 bg-white p-6 lg:rounded-none lg:border-0 dark:border-white/[0.06] dark:bg-[#0e1416]">
                    <Skeleton active paragraph={{ rows: 5 }} />
                </div>
            ) : (
                <div className="rounded-[12px] border border-black/10 bg-white lg:rounded-none lg:border-0 dark:border-white/[0.06] dark:bg-[#0e1416]">
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
    const content = (
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs leading-[18px] ${meta.text}`}>
            {status === "testing" ? <RefreshCw className="size-3 motion-safe:animate-spin" /> : <span className={`size-2 rounded-full ${meta.dot}`} />}
            {meta.label}
        </span>
    );
    return message ? <Tooltip title={message}>{content}</Tooltip> : content;
}
