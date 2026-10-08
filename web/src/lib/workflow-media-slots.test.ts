import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowChannelData, WorkflowEntry, WorkflowRef } from "./workflow-channel";
import { bindWorkflowMediaSlots, findWorkflowEntry, normalizeWorkflowMediaSlotModes, workflowMediaSlots } from "./workflow-media-slots";

const ref: WorkflowRef = { scope: "personal", channelId: "comfy", kind: "workflow", workflowId: "h3.json" };
const entry: WorkflowEntry = {
    provider: "comfyui",
    kind: "workflow",
    workflowId: "h3.json",
    title: "H3",
    capability: "video",
    enabled: true,
    fields: [
        { nodeId: "1", fieldName: "image", source: "referenceImage", imageOrder: 1, optionalMedia: true, mediaDefaultMode: "off", mediaPrunePlan: { removeNodeIds: ["1"], detachInputs: [] } },
        { nodeId: "2", fieldName: "image", source: "referenceImage", imageOrder: 3, optionalMedia: true, mediaDefaultMode: "canvas", mediaPrunePlan: { removeNodeIds: ["2"], detachInputs: [{ nodeId: "7", fieldName: "ref_images.ref_image_2" }] } },
        { nodeId: "3", fieldName: "audio", source: "referenceAudio", sourceIndex: 1, optionalMedia: true, mediaDefaultMode: "default", mediaPrunePlan: { removeNodeIds: ["3"], detachInputs: [] } },
        { nodeId: "4", fieldName: "image", source: "referenceImage", sourceIndex: 4, optionalMedia: true, mediaDefaultMode: "off" },
    ],
};
const channels: WorkflowChannelData[] = [{ protocol: "comfyui", channelId: "comfy", workflows: [entry] }];

test("workflow reference resolves its saved full entry", () => {
    assert.equal(findWorkflowEntry(channels, ref), entry);
    assert.equal(findWorkflowEntry(channels, { ...ref, workflowId: "missing.json" }), undefined);
});

test("slot derivation keeps only safe optional fields and their real indices", () => {
    assert.deepEqual(workflowMediaSlots(entry).map(({ id, mediaType, index }) => ({ id, mediaType, index })), [
        { id: "1::image", mediaType: "image", index: 0 },
        { id: "2::image", mediaType: "image", index: 2 },
        { id: "3::audio", mediaType: "audio", index: 1 },
    ]);
});

test("stored slot modes are normalized against configured defaults", () => {
    const modes = normalizeWorkflowMediaSlotModes(workflowMediaSlots(entry), { "1::image": "canvas", "2::image": "broken" as never });
    assert.deepEqual(modes, { "1::image": "canvas", "2::image": "canvas", "3::audio": "default" });
});

test("sparse bindings do not shift a later enabled slot", () => {
    const slots = workflowMediaSlots(entry);
    const image = { id: "img" };
    const result = bindWorkflowMediaSlots(slots, { "1::image": "off", "2::image": "canvas", "3::audio": "default" }, { images: [image], videos: [], audios: [] });
    assert.equal(result.error, undefined);
    assert.equal(result.images.length, 3);
    assert.equal(result.images[0], undefined);
    assert.equal(result.images[2], image);
    assert.deepEqual(result.audios, []);
});

test("all optional slots may be off", () => {
    const result = bindWorkflowMediaSlots(workflowMediaSlots(entry), { "1::image": "off", "2::image": "off", "3::audio": "off" }, { images: [], videos: [], audios: [] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.audios, []);
});

test("an enabled canvas slot reports its exact missing position", () => {
    const result = bindWorkflowMediaSlots(workflowMediaSlots(entry), { "1::image": "off", "2::image": "canvas", "3::audio": "off" }, { images: [], videos: [], audios: [] });
    assert.equal(result.error, "参考图片 3 已启用，但没有画布素材");
});
