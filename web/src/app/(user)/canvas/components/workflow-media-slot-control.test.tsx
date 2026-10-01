import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowMediaSlot } from "@/lib/workflow-media-slots";
import { WorkflowMediaSlotControl } from "./workflow-media-slot-control";

test("optional media control exposes totals, batch actions and every slot mode", () => {
    const slots: WorkflowMediaSlot[] = [
        { id: "1::image", mediaType: "image", index: 0, label: "角色参考", defaultMode: "off" },
        { id: "2::audio", mediaType: "audio", index: 0, label: "声音参考", defaultMode: "canvas" },
    ];
    const html = renderToStaticMarkup(<WorkflowMediaSlotControl slots={slots} modes={{ "1::image": "off", "2::audio": "canvas" }} onChange={() => undefined} />);
    assert.match(html, /参考媒体 1\/2/);
    assert.match(html, /全部关闭/);
    assert.match(html, /全部启用/);
    assert.match(html, /角色参考/);
    assert.match(html, /声音参考/);
    assert.match(html, /工作流默认/);
});
