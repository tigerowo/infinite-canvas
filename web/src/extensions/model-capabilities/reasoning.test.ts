import test from "node:test";
import assert from "node:assert/strict";
import { reasoningFields, reasoningOptions, resolveReasoning } from "./reasoning";

test("text effort reaches Chat and Responses without changing auto defaults", () => {
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", "low"), { reasoning_effort: "low" });
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "responses", "xhigh"), { reasoning: { effort: "xhigh" } });
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", "auto", true), {});
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", undefined, true), { reasoning_effort: "high" });
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", "none"), { reasoning_effort: "none" });
});

test("model changes cannot send unsupported effort levels", () => {
    assert.equal(resolveReasoning("gemini-3.1-pro-preview", "newapi", "xhigh"), "auto");
    assert.ok(!reasoningOptions("gemini-3-pro-preview", "gemini").includes("medium"));
    assert.deepEqual(reasoningFields("gemini-3.1-pro-preview", "gemini", "gemini", "medium"), { generationConfig: { thinkingConfig: { thinkingLevel: "medium" } } });
    assert.deepEqual(reasoningFields("unknown-model", "newapi", "chat", "high"), {});
});
