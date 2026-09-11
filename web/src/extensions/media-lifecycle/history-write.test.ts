import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryWriteQueue, mergeHistoryRefresh } from "./history-write";
import { preserveTerminalHistory } from "../media-reliability/task-state";

test("delayed history writes finish before a newer recovery and its deletion", async () => {
    const enqueue = createHistoryWriteQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const disk = new Map<string, { status: string; archiveRecovery: number }>();
    const failed = enqueue(async () => { await blocked; disk.set("task", { status: "失败", archiveRecovery: 0 }); });
    const retry = enqueue(async () => { disk.set("task", { status: "生成中", archiveRecovery: 2 }); });
    release();
    await Promise.all([failed, retry]);
    assert.equal(disk.get("task")?.archiveRecovery, 2);
    await enqueue(async () => { disk.delete("task"); });
    assert.equal(disk.has("task"), false);
});

test("a refresh cannot resurrect a deleted task or erase a task created while loading", () => {
    const old = { id: "old", status: "生成中", archiveRecovery: 0 };
    const fresh = { id: "new", status: "生成中", archiveRecovery: 0 };
    assert.deepEqual(mergeHistoryRefresh([old], [fresh], [{ ...old, status: "成功" }]), [fresh]);
});

test("a delayed refresh preserves an in-flight local recovery but accepts a newer server revision", () => {
    const old = { id: "task", status: "失败", archiveRecovery: 0 };
    const retry = { ...old, status: "生成中", archiveRecovery: 2 };
    assert.deepEqual(mergeHistoryRefresh([old], [retry], [old]), [retry]);
    const newer = { ...old, status: "成功", archiveRecovery: 3 };
    assert.deepEqual(mergeHistoryRefresh([old], [retry], [newer]), [newer]);
});

test("a failed local write does not block later task saves", async () => {
    const enqueue = createHistoryWriteQueue();
    const failed = enqueue(async () => { throw new Error("disk unavailable"); });
    const recovered = enqueue(async () => "saved");
    await assert.rejects(failed, /disk unavailable/);
    assert.equal(await recovered, "saved");
});

test("an old failed response cannot replace a successful result at the same recovery revision", () => {
    const current = { status: "成功", archiveRecovery: 2 };
    assert.equal(preserveTerminalHistory(current, { status: "失败", archiveRecovery: 2 }), current);
    assert.equal(preserveTerminalHistory(current, { status: "生成中", archiveRecovery: 3 }).archiveRecovery, 3);
});
