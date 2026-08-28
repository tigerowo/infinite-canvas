import { describe, expect, it } from "vitest";

import { userLikelyRequestedCanvasAction } from "./canvas-agent-tools";

describe("canvas Agent action intent", () => {
    it("does not treat an explicit no-action request as an action", () => {
        expect(userLikelyRequestedCanvasAction("只回复 OK，不执行任何画布操作")).toBe(false);
    });

    it("keeps ordinary canvas requests actionable", () => {
        expect(userLikelyRequestedCanvasAction("创建一个文本节点")).toBe(true);
    });
});
