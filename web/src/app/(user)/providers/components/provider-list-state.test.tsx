/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ProviderListState, ProviderStatusTag, ProviderSummary } from "./provider-list-state";

beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
});

describe("connection center list states", () => {
    it("shows pending summary counts while the initial list is loading", () => {
        render(<ProviderSummary count={0} connectedCount={0} pending />);
        expect(screen.getAllByText("—")).toHaveLength(2);
        expect(screen.getByText("SSRF 防护与响应限额已启用")).toBeInTheDocument();
    });

    it("shows a skeleton instead of an empty-state action while loading", () => {
        const { container } = render(<ProviderListState kind="api" loading error="" onCreate={vi.fn()} onRetry={vi.fn()} />);
        expect(container.querySelector(".ant-skeleton")).toBeInTheDocument();
        expect(screen.queryByText("还没有 API 渠道")).not.toBeInTheDocument();
    });

    it("shows only the error and retries without presenting the list as empty", () => {
        const onRetry = vi.fn();
        render(<ProviderListState kind="api" loading={false} error="隔离列表故障" onCreate={vi.fn()} onRetry={onRetry} />);
        expect(screen.getByText("连接列表读取失败")).toBeInTheDocument();
        expect(screen.getByText("隔离列表故障")).toBeInTheDocument();
        expect(screen.queryByText("还没有 API 渠道")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("keeps the API and CLI empty actions explicit", () => {
        const onCreate = vi.fn();
        const { rerender } = render(<ProviderListState kind="api" loading={false} error="" onCreate={onCreate} onRetry={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "添加第一个 API" }));
        expect(onCreate).toHaveBeenCalledOnce();
        rerender(<ProviderListState kind="cli" loading={false} error="" onCreate={onCreate} onRetry={vi.fn()} />);
        expect(screen.getByRole("button", { name: "登记 CLI" })).toBeInTheDocument();
    });

    it("keeps disabled and unavailable providers visually distinct", () => {
        render(
            <>
                <ProviderStatusTag status="disabled" />
                <ProviderStatusTag status="unavailable" />
            </>,
        );
        expect(screen.getByText("已禁用")).toBeInTheDocument();
        expect(screen.getByText("不可用")).toBeInTheDocument();
    });
});
