import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./task-state.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { hasTaskTerminalTimestamp, mergeTaskElapsedMs, normalizeTaskElapsedMs, taskElapsedMs } = module.exports;

test("terminal task duration is frozen at completion time", () => {
    const createdAt = Date.parse("2026-09-10T10:00:00Z");
    const task = { completed_at: "2026-09-10T10:08:30Z" };
    assert.equal(taskElapsedMs(createdAt, "成功", task, Date.parse("2026-09-11T10:00:00Z")), 510_000);
    assert.equal(hasTaskTerminalTimestamp(task), true);
});

test("a refreshed terminal task replaces an inflated running duration", () => {
    assert.equal(mergeTaskElapsedMs("成功", 23_000_000, "成功", 510_000, true), 510_000);
    assert.equal(mergeTaskElapsedMs("生成中", 500_000, "生成中", 505_000, false), 505_000);
});

test("stored terminal history repairs an inflated duration from task timestamps", () => {
    const task = { created_at: "2026-09-10T10:00:00Z", updated_at: "2026-09-10T10:08:30Z" };
    assert.equal(normalizeTaskElapsedMs(Date.parse("2026-09-10T09:59:58Z"), "成功", 23_000_000, task), 510_000);
    assert.equal(normalizeTaskElapsedMs(1_000, "成功", 42_000), 42_000);
});

test("provider updated_at cannot increase a frozen terminal duration", () => {
    const task = { created_at: "2026-09-10T10:00:00Z", updated_at: "2026-09-11T10:00:00Z" };
    assert.equal(normalizeTaskElapsedMs(Date.parse("2026-09-10T10:00:00Z"), "成功", 510_000, task), 510_000);
});

test("video workbench applies terminal duration repair while loading stored history", async () => {
    const pageSource = fs.readFileSync(new URL("../../app/(user)/video/page.tsx", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let normalizeLogSource = "";
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "normalizeLog") normalizeLogSource = node.getText(parsed);
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(normalizeLogSource);
    const context = {
        api: null,
        normalizeTaskElapsedMs,
        normalizeLogConfig: () => ({}),
        normalizeResolution: (value) => value,
        restoreHistoryFiles: async () => [],
        restoreHistoryImages: async () => [],
    };
    const output = ts.transpileModule(`${normalizeLogSource}\napi = normalizeLog;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(output, context);
    const log = await context.api({
        id: "task", status: "成功", createdAt: Date.parse("2026-09-10T09:59:58Z"), durationMs: 23_000_000,
        task: { created_at: "2026-09-10T10:00:00Z", completed_at: "2026-09-10T10:08:30Z" },
    });
    assert.equal(log.durationMs, 510_000);
});
