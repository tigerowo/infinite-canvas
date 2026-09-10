import test from "node:test";
import assert from "node:assert/strict";
import { reasoningFields, reasoningOptions, resolveReasoning } from "./reasoning";

test("reasoning stays off until selected and preserves old explicit choices", () => {
    assert.equal(resolveReasoning("custom-model", "newapi"), "none");
    assert.equal(resolveReasoning("custom-model", "newapi", "auto"), "none");
    assert.equal(resolveReasoning("custom-model", "newapi", "minimal"), "low");
    assert.deepEqual(reasoningFields("custom-model", "newapi", "chat"), {});
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", "low"), { reasoning_effort: "low" });
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "responses", "xhigh"), { reasoning: { effort: "xhigh" } });
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", "auto", true), {});
    assert.deepEqual(reasoningFields("gpt-5.5", "newapi", "chat", undefined, true), { reasoning_effort: "high" });
    for (const mode of ["chat", "responses", "gemini"] as const) {
        assert.deepEqual(reasoningFields("custom-model", "newapi", mode, "none"), {});
    }
});

test("every text model exposes five manual levels and keeps the user's choice", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const [model, protocol] of [["custom-model", "newapi"], ["gpt-5.5", "openai"], ["gemini-3-pro-preview", "gemini"], ["mimo-model", "mimo"]]) {
        assert.deepEqual(reasoningOptions(model, protocol), ["none", ...levels]);
        for (const effort of levels) {
            assert.equal(resolveReasoning(model, protocol, effort), effort);
            assert.deepEqual(reasoningFields(model, protocol, "responses", effort), { reasoning: { effort } });
        }
    }
    assert.deepEqual(reasoningFields("gemini-3.1-pro-preview", "gemini", "gemini", "medium"), { generationConfig: { thinkingConfig: { thinkingLevel: "medium" } } });
    assert.deepEqual(reasoningFields("unknown-model", "newapi", "chat", "max"), { reasoning_effort: "max" });
    assert.deepEqual(reasoningFields("mimo-model", "mimo", "chat", "low"), { thinking: { type: "enabled" } });
});
