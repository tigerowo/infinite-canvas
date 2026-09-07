import assert from "node:assert/strict";
import test from "node:test";
import { filterChannelModelsByCapability, modelMatchesCapability } from "../../stores/use-config-store";

const videoAliases = ["lec-mj-wan-3-0-1080p", "lec-seed-2-0-900", "lec-seed-2-5-900"];

test("verified video aliases are selectable as video, never text", () => {
    const models = [...videoAliases, "wan3.0-image", "gpt-5.4"];
    const channels = [{ protocol: "openai" as const, models }];
    assert.deepEqual(filterChannelModelsByCapability(channels, "video"), videoAliases);
    assert.deepEqual(filterChannelModelsByCapability(channels, "text"), ["gpt-5.4"]);
    assert.deepEqual(filterChannelModelsByCapability(channels, "image"), ["wan3.0-image"]);
    for (const model of videoAliases) {
        assert.equal(modelMatchesCapability(` ${model.toUpperCase()} `, "video"), true);
        assert.equal(modelMatchesCapability(model, "audio"), false);
    }
    assert.equal(modelMatchesCapability("lec-seed-unknown", "video"), false);
});
