import assert from "node:assert/strict";
import test from "node:test";

import { workflowMediaPruneSummary } from "./workflow-field-mapping-editor";

test("workflow media prune summary only describes Bridge-approved plans", () => {
    assert.equal(workflowMediaPruneSummary({ nodeId: "1", fieldName: "image", source: "referenceImage" }), undefined);
    assert.equal(
        workflowMediaPruneSummary({
            nodeId: "1",
            fieldName: "image",
            source: "referenceImage",
            mediaPrunePlan: { removeNodeIds: ["1", "2"], detachInputs: [{ nodeId: "7", fieldName: "ref_images.ref_image_0" }] },
        }),
        "关闭时删除 2 个节点，断开 1 个输入",
    );
});
