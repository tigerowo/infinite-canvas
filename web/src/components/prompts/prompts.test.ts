import assert from "node:assert/strict";
import test from "node:test";
import { promptPageCount, uniquePromptItems } from "./use-prompt-list";
import { promptPreview } from "@/extensions/glass-ui/prompt-preview";

const prompt = (id: string) => ({ id, title: id, coverUrl: "", prompt: id, tags: [], category: "test", githubUrl: "", preview: "", createdAt: "", updatedAt: "" });

test("deduplicates repeated IDs within a prompt page before rendering", () => {
    assert.deepEqual(uniquePromptItems([prompt("a"), prompt("a"), prompt("b")]).map((item) => item.id), ["a", "b"]);
});

test("calculates stable prompt page counts", () => {
    assert.equal(promptPageCount(1593, 20), 80);
    assert.equal(promptPageCount(0, 20), 1);
    assert.equal(promptPageCount(10, 0), 10);
});

test("creates a bounded display preview without changing the source prompt", () => {
    const source = "  一段很长的提示词\n\n" + "画面细节 ".repeat(60);
    const preview = promptPreview(source);
    assert.equal(preview.endsWith("…"), true);
    assert.equal(Array.from(preview).length, 121);
    assert.equal(source.includes("\n\n"), true);
});

test("keeps short prompt whitespace readable in the preview", () => {
    assert.equal(promptPreview("  电影感\n\n柔和光线  "), "电影感 柔和光线");
});
