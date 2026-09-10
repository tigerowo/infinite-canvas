import assert from "node:assert/strict";
import test from "node:test";
import { directProtocolAdapters } from "./direct-registry";
import { collectHTTPURLs, normalizeDirectStatus, readDirectError } from "./shared";

// Expectations are taken from direct-ai.ts at a27f046, before protocol extraction.
test("direct protocols preserve polling paths and task ID precedence", () => {
    assert.deepEqual(Object.keys(directProtocolAdapters).sort(), ["apimart", "autodl", "kie"]);
    assert.equal(directProtocolAdapters.kie.pollPath("task/a b?"), "/jobs/recordInfo?taskId=task%2Fa%20b%3F");
    assert.equal(directProtocolAdapters.apimart.pollPath("task/a b?"), "/tasks/task%2Fa%20b%3F?language=zh");
    assert.equal(directProtocolAdapters.kie.readTaskId({ data: { taskId: " kie-task ", task_id: "ignored" } }), "kie-task");
    assert.equal(directProtocolAdapters.kie.readTaskId({ data: { taskId: 123, id: "ignored" } }), "");
    assert.equal(directProtocolAdapters.apimart.readTaskId({ data: [{ task_id: " array-task ", id: "ignored" }] }), "array-task");
    assert.equal(directProtocolAdapters.apimart.readTaskId({ data: { task_id: " task-id ", id: "fallback" } }), "task-id");
    assert.equal(directProtocolAdapters.apimart.readTaskId({ data: { task_id: " ", id: " fallback " } }), "fallback");
    assert.equal(directProtocolAdapters.apimart.readTaskId({ data: [{ id: "not-a-task-id" }] }), "");
});

test("created video status retains provider-specific behavior", () => {
    assert.equal(directProtocolAdapters.kie.readCreatedVideoStatus({ data: [{ status: "failed" }] }), "processing");
    assert.equal(directProtocolAdapters.apimart.readCreatedVideoStatus({ data: [{ status: "success" }] }), "completed");
    assert.equal(directProtocolAdapters.apimart.readCreatedVideoStatus({ data: [{ status: "cancelled" }] }), "failed");
    assert.equal(directProtocolAdapters.apimart.readCreatedVideoStatus({ data: { status: "completed" } }), "processing");
});

test("APIMart synchronous images keep URL order, nesting and deduplication", () => {
    const payload = { data: [
        { url: " https://media.example/one.png " },
        { url: ["https://media.example/two.png", "https://media.example/one.png", "data:image/png;base64,AAAA"] },
        { b64_json: "ignored", other: "https://media.example/ignored.png" },
    ] };
    assert.deepEqual(directProtocolAdapters.apimart.readCreatedImageURLs?.(payload), [
        "https://media.example/one.png", "https://media.example/two.png",
    ]);
    assert.deepEqual(directProtocolAdapters.kie.readCreatedImageURLs?.(payload) || [], []);
    assert.deepEqual(directProtocolAdapters.apimart.readCreatedImageURLs?.({ data: { url: "https://media.example/one.png" } }), []);
});

test("image polling keeps status aliases, result shapes and failure precedence", () => {
    const result = { resultUrls: ["https://media.example/one.png", "https://media.example/two.png", "https://media.example/one.png"] };
    assert.deepEqual(directProtocolAdapters.kie.readImagePoll({ data: { state: "success", resultJson: JSON.stringify(result) } }), {
        urls: ["https://media.example/one.png", "https://media.example/two.png"], done: true, error: "",
    });
    assert.deepEqual(directProtocolAdapters.apimart.readImagePoll({ data: { result } }), {
        urls: ["https://media.example/one.png", "https://media.example/two.png"], done: true, error: "",
    });
    assert.deepEqual(directProtocolAdapters.kie.readImagePoll({ code: 500, msg: "outer", data: { state: "failed", failMsg: "specific", failCode: "code" } }), {
        urls: [], done: false, error: "specific",
    });
    assert.deepEqual(directProtocolAdapters.apimart.readImagePoll({ code: 500, msg: "outer", data: { status: "failed", error: { message: "specific" } } }), {
        urls: [], done: false, error: "specific",
    });
    for (const provider of ["kie", "apimart"] as const) {
        for (const [status, expected] of [["success", "completed"], ["succeeded", "completed"], ["completed", "completed"], ["fail", "failed"], ["failed", "failed"], ["cancelled", "failed"], ["canceled", "failed"], ["queued", "processing"], ["", "processing"]] as const) {
            const data = provider === "kie" ? { state: status } : { status };
            assert.deepEqual(directProtocolAdapters[provider].readImagePoll({ data }), {
                urls: [], done: expected === "completed", error: expected === "failed" ? "图片生成失败" : "",
            }, `${provider}: ${status}`);
        }
    }
});

test("video polling preserves result URL, progress types and error precedence", () => {
    assert.deepEqual(directProtocolAdapters.kie.readVideoPoll({ data: {
        taskId: " remote ", state: "succeeded", progress: "25.5",
        resultJson: '{"resultUrls":["https://media.example/first.mp4","https://media.example/second.mp4"]}',
    } }, "local", "model-x"), {
        id: "remote", task_id: "remote", status: "completed", progress: 25.5,
        video_url: "https://media.example/first.mp4", url: "https://media.example/first.mp4", model: "model-x",
    });
    assert.deepEqual(directProtocolAdapters.apimart.readVideoPoll({ data: {
        id: " remote ", status: "cancelled", progress: "not-a-number", error: { message: " rejected " },
    } }, "local", "model-x"), {
        id: "remote", task_id: "remote", status: "failed", progress: undefined, error: { message: "rejected" }, model: "model-x",
    });
    for (const provider of ["kie", "apimart"] as const) {
        assert.deepEqual(directProtocolAdapters[provider].readVideoPoll({}, "fallback", "model-x"), {
            id: "fallback", task_id: "fallback", status: "processing", progress: undefined, model: "model-x",
        });
    }
    assert.equal(directProtocolAdapters.kie.readVideoPoll({ data: { failMsg: "first", failCode: "second" }, error: { message: "outer" } }, "id", "model").error?.message, "first");
});

test("shared parsing keeps business errors and does not treat plain messages as failures", () => {
    for (const payload of [{}, { code: 0, message: "ok" }, { code: "200", msg: "ok" }, { message: "raw upstream text" }]) {
        assert.equal(readDirectError(payload), "");
    }
    assert.equal(readDirectError({ code: "429", msg: " slow down ", message: "fallback" }), "slow down");
    assert.equal(readDirectError({ code: 500 }), "上游请求失败：500");
    assert.equal(readDirectError({ error: { message: "outer" }, data: { error: { message: "inner" }, failMsg: "task" } }), "outer");
    assert.equal(readDirectError({ data: { failCode: "task-code" } }), "task-code");
    assert.equal(normalizeDirectStatus(" SUCCESS "), "completed");
    assert.equal(normalizeDirectStatus("unknown"), "processing");
    for (const protocol of Object.values(directProtocolAdapters)) {
        assert.equal(protocol.readError({ code: 500 }), "上游请求失败：500");
    }
});

test("recursive URL parsing retains its original depth boundary", () => {
    let value: unknown = "https://media.example/result.png";
    for (let depth = 0; depth < 8; depth++) value = { nested: value };
    assert.deepEqual(collectHTTPURLs(value), ["https://media.example/result.png"]);
    assert.deepEqual(collectHTTPURLs({ nested: value }), []);
    assert.deepEqual(collectHTTPURLs('{"urls":["https://media.example/result.png"]}'), ["https://media.example/result.png"]);
    assert.deepEqual(collectHTTPURLs("not-json"), []);
});

test("AutoDL uses raw token and polls the workflow result endpoint without adding v1", () => {
    const protocol = directProtocolAdapters.autodl;
    assert.equal(protocol.rawAuthorization, true);
    assert.equal(protocol.readTaskId({ code: "Success", data: { task_id: "created-once" } }), "created-once");
    assert.equal(protocol.readTaskId({ code: "Success", data: {} }), "");
    for (const base of ["https://autodl.art", "https://autodl.art/"]) {
        assert.equal(protocol.pollURL?.(base, "task/a b?"), "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/task%2Fa%20b%3F");
    }
    assert.equal(protocol.pollURL?.("https://proxy.example/autodl", "task"), "https://proxy.example/autodl/api/v1/comfyui/comfyui_workflow/result/task");
    assert.equal(directProtocolAdapters.kie.rawAuthorization, undefined);
    assert.equal(directProtocolAdapters.apimart.rawAuthorization, undefined);
});

test("AutoDL separates output media from input and preview URLs and does not invent progress", () => {
    const protocol = directProtocolAdapters.autodl;
    const payload = { code: "Success", data: {
        task_id: "created-once", status: "SUCCESS", duration: 12,
        input: { url: "https://media.example/input.mp4" },
        results: [
            { type: "image", url: "https://media.example/poster.png" },
            { type: "video", output_type: "preview", url: "https://media.example/preview.mp4" },
            { type: "audio", output_type: "output", url: "https://media.example/speech.wav" },
            { type: "video", output_type: "output", url: "https://media.example/final.mp4" },
        ],
    } };
    const video = protocol.readVideoPoll(payload, "created-once", "minimax_h3_b99_002");
    assert.equal(video.video_url, "https://media.example/final.mp4");
    assert.equal(video.status, "completed");
    assert.equal(video.progress, undefined);
    assert.deepEqual(protocol.readAudioPoll?.(payload), { url: "https://media.example/speech.wav", done: true, error: "" });
    for (const status of ["QUEUED", "RUNNING"]) {
        assert.equal(protocol.readVideoPoll({ code: "Success", data: { status } }, "created-once", "model").status, "processing");
    }
});

test("AutoDL reports string business errors, task failures and completed tasks without outputs", () => {
    const protocol = directProtocolAdapters.autodl;
    assert.equal(protocol.readError({ code: "InsufficientBalance", msg: "额度不足" }), "额度不足");
    assert.equal(protocol.readError({ code: "Success", data: { status: "FAILED", message: "参考文件不可读取" } }), "参考文件不可读取");
    const empty = { code: "Success", data: { status: "completed", results: [{ type: "image", url: "https://media.example/poster.png" }] } };
    assert.equal(protocol.readVideoPoll(empty, "task", "model").status, "failed");
    assert.match(protocol.readVideoPoll(empty, "task", "model").error?.message || "", /没有返回视频地址/);
    assert.match(protocol.readAudioPoll?.(empty).error || "", /没有返回音频地址/);
});
