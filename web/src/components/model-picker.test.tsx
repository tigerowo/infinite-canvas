/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, type LocalModelChannel } from "@/stores/use-config-store";

beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
    Object.defineProperty(window, "PointerEvent", {
        writable: true,
        value: class extends MouseEvent {
            pointerType: string;
            constructor(type: string, init: PointerEventInit = {}) {
                super(type, init);
                this.pointerType = init.pointerType || "mouse";
            }
        },
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", { writable: true, value: vi.fn(() => false) });
    Object.defineProperty(Element.prototype, "setPointerCapture", { writable: true, value: vi.fn() });
    Object.defineProperty(Element.prototype, "releasePointerCapture", { writable: true, value: vi.fn() });
    Object.defineProperty(Element.prototype, "scrollIntoView", { writable: true, value: vi.fn() });
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
});

afterEach(() => {
    cleanup();
    window.localStorage.clear();
});

describe("model picker states", () => {
    it("prioritizes the current and connected models while exposing real channel states", () => {
        const channels: LocalModelChannel[] = [
            channel("connected", "Antigravity", ["gemini-3.1-pro-high", "gemini-3.7-flash-low"], "connected", "gemini-3.7-flash-low"),
            channel("untested", "Gemini 原生", ["gemini-2.5-pro"], "untested", "", "gemini"),
            channel("unavailable", "不可用渠道", ["blocked-text-model"], "unavailable", "", "openai"),
        ];
        render(<ModelPicker config={{ ...defaultConfig, localChannels: channels }} value="gemini-3.1-pro-high" channelId="connected" capability="text" onChange={vi.fn()} />);

        const trigger = screen.getByRole("combobox");
        expect(trigger).toHaveTextContent("Gemini 3.1 Pro · High · CLI");
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

        const options = screen.getAllByRole("option");
        expect(options[0]).toHaveTextContent("Gemini 3.1 Pro · High · CLI已选可用");
        expect(options[1]).toHaveTextContent("Gemini 3.7 Flash · Low · CLI推荐可用");
        expect(options[2]).toHaveTextContent("Gemini 2.5 Pro未测试");
        expect(options[3]).toHaveTextContent("blocked-text-model不可用");
        expect(options[3]).toHaveAttribute("aria-disabled", "true");
    });

    it("moves recently selected models ahead of unused models", () => {
        const channels: LocalModelChannel[] = [channel("connected", "Antigravity", ["model-a", "model-b", "model-c"], "connected")];
        render(<ModelPicker config={{ ...defaultConfig, localChannels: channels }} capability="text" onChange={vi.fn()} />);

        const trigger = screen.getByRole("combobox");
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        fireEvent.click(screen.getByRole("option", { name: /model-b/ }));
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

        expect(screen.getAllByRole("option")[0]).toHaveTextContent("model-b最近可用");
    });
});

function channel(id: string, name: string, models: string[], connectionStatus: LocalModelChannel["connectionStatus"], defaultModel = "", protocol: LocalModelChannel["protocol"] = "gemini-cli"): LocalModelChannel {
    return { id, protocol, name, baseUrl: "", apiKey: "", models, capabilities: ["text"], defaultModel, managed: true, enabled: true, connectionStatus };
}
