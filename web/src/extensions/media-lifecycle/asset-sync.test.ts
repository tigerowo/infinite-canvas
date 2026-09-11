import assert from "node:assert/strict";
import test from "node:test";
import { mergeAssetCollection, synchronizeAssetCollection, type AssetCollection } from "./asset-sync";

const old = { id: "old", title: "原始", note: "", data: { content: "文字" }, updatedAt: "1" };
const added = { ...old, id: "new" };

test("asset sync merges independent additions and fields without trusting client clocks", () => {
    assert.deepEqual(mergeAssetCollection([old], [old, added], [old, { ...added, id: "remote" }]).map((a) => a.id), ["old", "remote", "new"]);
    const merged = mergeAssetCollection([old], [{ ...old, title: "本机", updatedAt: "0" }], [{ ...old, note: "远端", updatedAt: "9" }]);
    assert.equal(merged[0].title, "本机");
    assert.equal(merged[0].note, "远端");
    assert.throws(() => mergeAssetCollection([old], [{ ...old, title: "本机" }], [{ ...old, title: "远端" }]), /其他浏览器修改/);
});

test("asset deletion wins over a stale edit in either browser", () => {
    assert.deepEqual(mergeAssetCollection([old], [{ ...old, title: "编辑" }, added], []), [added]);
    assert.deepEqual(mergeAssetCollection([old], [], [{ ...old, title: "编辑" }]), []);
});

test("asset sync rebases after a concurrent save and preserves newer local edits after acceptance", async () => {
    let remote: AssetCollection<typeof old> = { assets: [old], revision: "1" };
    let writes = 0;
    const accepted = await synchronizeAssetCollection({ base: remote, local: [old, added], check() {}, read: async () => remote, write: async (data) => {
        if (++writes === 1) { remote = { assets: [old, { ...added, id: "other" }], revision: "2" }; throw new Error("数据版本已变化，请重新同步"); }
        assert.equal(data.revision, "2");
        return { ...data, revision: "3" };
    } });
    assert.deepEqual(accepted.assets.map((a) => a.id), ["old", "other", "new"]);
    assert.deepEqual(mergeAssetCollection([old, added], [old, { ...added, title: "请求期间的修改" }], accepted.assets).find((a) => a.id === "new")?.title, "请求期间的修改");
});

test("asset sync rejects account or epoch changes and never adopts an unowned snapshot", async () => {
    let valid = true, writes = 0;
    const base = { assets: [old], revision: "1" };
    await assert.rejects(synchronizeAssetCollection({ base, local: [old, added], check() { if (!valid) throw new Error("账号变化"); }, read: async () => { valid = false; return base; }, write: async (data) => { writes++; return data; } }), /账号变化/);
    assert.equal(writes, 0);
    await assert.rejects(synchronizeAssetCollection({ base: null, local: [old], check() {}, read: async () => base, write: async (data) => data }), /缺少同步基线/);
});

test("asset sync does not renew unchanged data or retry an ambiguous transport failure", async () => {
    const base = { assets: [old], revision: "1" };
    let writes = 0;
    const transport = { read: async () => base, check() {}, write: async () => { writes++; throw new Error("网络中断"); } };
    assert.deepEqual(await synchronizeAssetCollection({ ...transport, base, local: [old] }), base);
    assert.equal(writes, 0);
    await assert.rejects(synchronizeAssetCollection({ ...transport, base, local: [old, added] }), /网络中断/);
    assert.equal(writes, 1);
});
