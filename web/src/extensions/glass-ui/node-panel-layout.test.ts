import test from "node:test";
import assert from "node:assert/strict";
import { fitNodePanel } from "./node-panel-layout";

test("node panels remain inside the canvas, even beside an open conversation", () => {
    const panel = fitNodePanel({ left: 1050, right: 1290, top: 600, bottom: 840 }, { left: 0, right: 1125, top: 64, bottom: 848 }, 622, 280);
    assert.ok(panel.left + panel.width <= 1125 - 12);
    assert.ok(panel.top + 280 <= 848 - 12);
    assert.ok(panel.top < 600);
    assert.equal(panel.visible, true);
});

test("panels shrink to available space and yield to a full-width conversation", () => {
    const anchor = { left: 100, right: 340, top: 100, bottom: 340 };
    const mobile = fitNodePanel(anchor, { left: 0, right: 390, top: 64, bottom: 780 }, 622, 900);
    assert.equal(mobile.width, 366);
    assert.equal(mobile.maxHeight, 692);
    assert.equal(mobile.top, 76);
    assert.equal(fitNodePanel(anchor, { left: 0, right: 0, top: 64, bottom: 780 }, 622, 280).visible, false);
});
