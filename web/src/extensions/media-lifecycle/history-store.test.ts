import assert from "node:assert/strict";
import test from "node:test";
import { scopedHistoryStore } from "./history-store";

function setup() {
    const disk = new Map<string, unknown>([["legacy-task", { prompt: "unknown owner" }]]);
    let active = "a:1:";
    const raw = {
        async getItem<T>(key: string) { return (disk.get(key) as T) ?? null; },
        async setItem<T>(key: string, value: T) { disk.set(key, value); return value; },
        async removeItem(key: string) { disk.delete(key); },
        async keys() { return [...disk.keys()]; },
        async iterate<T, U>(visit: (value: T, key: string, i: number) => U) {
            let index = 0;
            for (const [key, value] of disk) { const result = visit(value as T, key, ++index); if (result !== undefined) return result; }
            return undefined as U;
        },
    };
    const store = scopedHistoryStore(raw as never, async () => {
        const prefix = active;
        return { prefix, check: () => { if (active !== prefix) throw new Error("session changed"); } };
    });
    return { disk, raw, store, switchTo: (value: string) => { active = value; } };
}

test("history and clearing are isolated by account and sync epoch; legacy records stay untouched", async () => {
    const env = setup();
    assert.deepEqual(await env.store.keys(), []);
    await env.store.setItem("task", { prompt: "account a" });
    env.switchTo("b:1:");
    assert.equal(await env.store.getItem("task"), null);
    await env.store.setItem("task", { prompt: "account b" });
    env.switchTo("a:2:");
    assert.equal(await env.store.getItem("task"), null);
    await env.store.setItem("task", { prompt: "after clear" });
    await env.store.clear();
    env.switchTo("a:1:");
    assert.deepEqual(await env.store.getItem("task"), { prompt: "account a" });
    const seen: string[] = [];
    await env.store.iterate((_value, key) => { seen.push(key); });
    assert.deepEqual(seen, ["task"]);
    assert.equal(env.disk.has("legacy-task"), true);
    assert.equal(env.disk.has("b:1:task"), true);
});

test("a late history read rejects account switch before exposing the record", async () => {
    const env = setup();
    await env.store.setItem("task", { prompt: "private a" });
    const read = env.raw.getItem;
    env.raw.getItem = async <T>(key: string) => { env.switchTo("b:1:"); return read<T>(key); };
    await assert.rejects(env.store.getItem("task"), /session changed/);
});
