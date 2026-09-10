import assert from "node:assert/strict";
import test from "node:test";
import { directAIProviderForProtocol, modelChannelApiKeyUrls, modelChannelDefaultBaseUrls, modelChannelProtocolOptions } from "./model-channel";

test("built-in protocol options retain both settings panels' labels and order", () => {
    assert.deepEqual(modelChannelProtocolOptions, [
        { label: "NewAPI", value: "newapi" },
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: "Grok2API", value: "grok2api" },
        { label: "MiniMax & METASO", value: "metaso" },
        { label: "APIMart", value: "apimart" },
        { label: "88API", value: "88api" },
        { label: "KIE", value: "kie" },
        { label: "AutoDL", value: "autodl" },
        { label: "MiMo", value: "mimo" },
    ]);
});

test("built-in protocols retain all existing default URLs and API Key links", () => {
    assert.deepEqual(modelChannelDefaultBaseUrls, {
        newapi: "",
        openai: "https://api.openai.com",
        gemini: "https://generativelanguage.googleapis.com",
        grok2api: "",
        metaso: "https://metaso.cn/api/minimax",
        apimart: "https://api.apimart.ai/v1",
        kie: "https://api.kie.ai/api/v1",
        autodl: "https://autodl.art",
        mimo: "https://api.xiaomimimo.com",
        "88api": "https://88api.ai/v1",
    });
    assert.deepEqual(modelChannelApiKeyUrls, {
        metaso: "https://metaso.cn/minimax-h3/?s=tt",
        apimart: "https://apimart.ai/register?aff=fWMrEv",
        mimo: "https://platform.xiaomimimo.com/?ref=JFZQR2",
        "88api": "https://88api.ai/sign-up?aff=25ty",
    });
});

test("public parameter translation eligibility keeps exact protocol matching", () => {
    assert.equal(directAIProviderForProtocol("kie"), "kie");
    assert.equal(directAIProviderForProtocol("apimart"), "apimart");
    assert.equal(directAIProviderForProtocol("autodl"), "autodl");
    for (const protocol of ["openai", "gemini", "grok2api", "metaso", "mimo", "88api", "KIE", " kie ", "APIMart", "", "unknown"]) {
        assert.equal(directAIProviderForProtocol(protocol), null, protocol);
    }
});
