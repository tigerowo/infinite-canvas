import assert from "node:assert/strict";
import test from "node:test";
import { mergeWorkflowFieldMappings, normalizeWorkflowFieldMappings } from "./workflow-channel";

test("optional media settings survive normalization", () => {
    const [field] = normalizeWorkflowFieldMappings([{
        nodeId: "217",
        fieldName: "image",
        source: "referenceImage",
        optionalMedia: true,
        mediaDefaultMode: "off",
        mediaPrunePlan: { removeNodeIds: ["217"], detachInputs: [{ nodeId: "220", fieldName: "ref_image" }] },
    }], "video");

    assert.equal(field.optionalMedia, true);
    assert.equal(field.mediaDefaultMode, "off");
    assert.deepEqual(field.mediaPrunePlan, { removeNodeIds: ["217"], detachInputs: [{ nodeId: "220", fieldName: "ref_image" }] });
});

test("workflow refresh keeps user slot policy and replaces the bridge prune plan", () => {
    const [field] = mergeWorkflowFieldMappings(
        [{ nodeId: "217", fieldName: "image", source: "referenceImage", optionalMedia: true, mediaDefaultMode: "off", mediaPrunePlan: { removeNodeIds: ["old"], detachInputs: [] } }],
        [{ nodeId: "217", fieldName: "image", source: "referenceImage", optionalMedia: false, mediaDefaultMode: "canvas", mediaPrunePlan: { removeNodeIds: ["217"], detachInputs: [{ nodeId: "220", fieldName: "ref_image" }] } }],
        "video",
    );

    assert.equal(field.optionalMedia, true);
    assert.equal(field.mediaDefaultMode, "off");
    assert.deepEqual(field.mediaPrunePlan, { removeNodeIds: ["217"], detachInputs: [{ nodeId: "220", fieldName: "ref_image" }] });
});
