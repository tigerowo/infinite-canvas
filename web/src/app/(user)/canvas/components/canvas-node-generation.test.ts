import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeGenerationContext } from "./canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "../types";

test("legacy frame metadata loads but cannot assign first or last frames to new tasks", () => {
    const video: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "test", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: { firstFrameNodeId: "image", lastFrameNodeId: "image", klingImageNodeIds: ["image"] } };
    const image: CanvasNodeData = { ...video, id: "image", type: CanvasNodeType.Image, metadata: { content: "https://media.example.com/reference.png" } };
    const context = buildNodeGenerationContext("video", [video, image], [{ id: "edge", fromNodeId: "image", toNodeId: "video" }], "test");
    assert.equal(context.firstFrame, null);
    assert.equal(context.lastFrame, null);
    assert.deepEqual(context.referenceImages.map((item) => item.id), ["image"]);
    assert.equal(video.metadata?.firstFrameNodeId, "image");
});
