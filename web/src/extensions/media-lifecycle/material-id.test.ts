import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { materialIds, remainingPasteText } from "./material-id";

describe("素材 ID 混合粘贴", () => {
    const a = "media_" + "a".repeat(32), b = "media_" + "b".repeat(32);
    it("仅替换成功项，保留文字、失败项和换行", () => {
        const text = `原图 ${a}\n修改内容 ${b} ${a}`;
        assert.deepEqual(materialIds(text), [a, b]);
        assert.equal(remainingPasteText(text, [a]), `原图 \n修改内容 ${b} `);
        assert.equal(remainingPasteText(text, []), text);
    });
});
