import assert from "node:assert/strict";
import test from "node:test";
import { preserveTerminalHistory } from "../media-reliability/task-state";
import { mergeProjectChanges } from "../media-reliability/project-merge";

test("another browser sees an authorized archive retry and rejects delayed old results", () => {
    const failed = { status: "失败", archiveRecovery: 0, task: { archiveRecovery: 0 } };
    const retry = { status: "生成中", archiveRecovery: 4, task: { archiveRecovery: 4 } };
    const freshBrowser = preserveTerminalHistory(failed, retry);
    assert.equal(freshBrowser.status, "生成中");
    assert.equal(preserveTerminalHistory(freshBrowser, failed), freshBrowser);
    const completed = { ...retry, status: "成功" };
    assert.equal(preserveTerminalHistory(completed, retry), completed);
});

test("canvas archive recovery survives another browser moving the failed node", () => {
    const base = { nodes: [{ id: "node", x: 0, metadata: { status: "failed", startedAt: 1, archiveRecovery: 0, errorDetails: "archive error" } }] };
    const retry = { nodes: [{ ...base.nodes[0], metadata: { status: "loading", startedAt: 1, archiveRecovery: 5 } }] };
    const moved = { nodes: [{ ...base.nodes[0], x: 100 }] };
    for (const result of [mergeProjectChanges(base, retry, moved), mergeProjectChanges(base, moved, retry)]) {
        assert.equal(result.nodes[0].x, 100);
        assert.equal(result.nodes[0].metadata.status, "loading");
        assert.equal(result.nodes[0].metadata.archiveRecovery, 5);
        assert.equal("errorDetails" in result.nodes[0].metadata, false);
    }
});
