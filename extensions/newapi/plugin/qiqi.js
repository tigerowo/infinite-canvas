export const meta = {
  apiVersion: 1,
  key: "qiqi",
  name: "QIQI",
  icon: "text:QI",
  description: {
    en: "QIQI video API using the stock Sora asynchronous protocol.",
    zh: "使用 stock Sora 异步协议的 QIQI 视频接口。",
  },
  version: "1.0.2",
  author: { name: "Custom" },
  models: [
    "chengfeng-3.0",
    "chengfeng-480p-pro",
    "chengfeng-720p-pro",
    "H3video-2k",
    "sora-v4-pro",
    "tejiasd",
    "tejiasd2",
  ],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位为秒。" },
    },
    size: {
      enum: ["720x1280", "1280x720", "1792x1024", "1024x1792"],
      description: { en: "Requested output video dimensions.", zh: "请求的输出视频尺寸。" },
    },
  },
  protocols: ["openai_video"],
};

function trimmed(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpoint(ctx, path) {
  const base = trimmed(ctx.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("Channel base URL must be HTTP(S)");
  return base + "/v1" + path;
}

function authHeaders(ctx) {
  const key = trimmed(ctx.apiKey);
  if (!key) throw new Error("QIQI channel API key is missing");
  return { Authorization: "Bearer " + key };
}

function taskBody(value) {
  let body = isObject(value) ? value : {};
  for (let i = 0; i < 3 && !body.status && isObject(body.data); i++) body = body.data;
  return body;
}

function errorMessage(value) {
  const body = taskBody(value);
  if (isObject(body.error)) return trimmed(body.error.message || body.error.code);
  return trimmed(body.error || body.message);
}

function requireSuccess(response, body, operation) {
  const status = Number(response && (response.statusCode || response.status));
  if (!status || (status >= 200 && status < 300)) return;
  const detail = errorMessage(body);
  throw new Error("QIQI " + operation + " failed with HTTP " + status + (detail ? ": " + detail : ""));
}

function requirePublicUrl(value, field) {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value))
    throw new Error(field + " must contain a public HTTP(S) URL");
}

const referenceArrays = ["images", "image_urls", "reference_images", "reference_image_urls", "videos", "video_urls", "reference_videos", "audios", "audio_urls"];
const canvasArrays = {
  input_reference: "reference_image_urls",
  video_reference: "reference_videos",
  audio_reference: "audio_urls",
};

function parseFormJSON(value, field) {
  try { return JSON.parse(value); }
  catch (e) { throw new Error(field + " must be valid JSON"); }
}

function appendReferences(req, field, values) {
  if (req[field] !== undefined && !Array.isArray(req[field])) throw new Error(field + " must be an array");
  req[field] = (req[field] || []).concat(values);
}

function normalizeCanvasRequest(req) {
  for (const field of Object.keys(canvasArrays)) {
    for (const alias of [field + "[]", ...(field === "input_reference" ? [] : [field])]) {
      if (req[alias] === undefined) continue;
      appendReferences(req, canvasArrays[field], Array.isArray(req[alias]) ? req[alias] : [req[alias]]);
      delete req[alias];
    }
  }
  if (req.last_frame_url) throw new Error("QIQI does not support last-frame images");
  if (req.first_frame_url) {
    if (req.image_url && req.image_url !== req.first_frame_url) throw new Error("Conflicting image_url and first_frame_url");
    req.image_url = req.first_frame_url;
  }
  delete req.first_frame_url;
  delete req.last_frame_url;
  if (req.resolution_name !== undefined) {
    if (req.resolution === undefined) req.resolution = req.resolution_name;
    delete req.resolution_name;
  }
  const canvas = isObject(req.metadata) ? req.metadata.canvas_video : undefined;
  if (canvas !== undefined) {
    if (!isObject(canvas) || canvas.version !== 1 || !Array.isArray(canvas.media)) throw new Error("Invalid Canvas v1 media");
    for (const media of canvas.media) {
      if (!isObject(media)) throw new Error("Invalid Canvas v1 media item");
      if (media.role === "last_frame") throw new Error("QIQI does not support last-frame images");
      if (media.role === "first_frame" && media.type === "image") {
        requirePublicUrl(media.url, "first_frame");
        if (req.image_url && req.image_url !== media.url) throw new Error("Conflicting first-frame images");
        req.image_url = media.url;
      } else {
        const field = { image: "reference_image_urls", video: "reference_videos", audio: "audio_urls" }[media.type];
        if (!field || media.role !== "reference") throw new Error("Unsupported Canvas media type or role");
        appendReferences(req, field, [media.url]);
      }
    }
    req.metadata = Object.assign({}, req.metadata);
    delete req.metadata.canvas_video;
    if (!Object.keys(req.metadata).length) delete req.metadata;
  }
  return req;
}

function decodeBody(ctx) {
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("JSON or multipart body required");
  if ((ctx.body.files || []).length || (ctx.files || []).length)
    throw new Error("QIQI does not accept file uploads; send public HTTP(S) URLs in text fields");
  if (ctx.body.kind === "json") {
    if (!isObject(ctx.body.value)) throw new Error("JSON object required");
    return normalizeCanvasRequest(Object.assign({}, ctx.body.value));
  }
  const req = Object.create(null);
  for (const name of Object.keys(ctx.body.fields || {})) {
    const values = ctx.body.fields[name];
    if (!Array.isArray(values) || !values.every(function (value) { return typeof value === "string"; }))
      throw new Error(name + " must contain text values");
    const field = name.replace(/\[\]$/, "");
    const multiple = referenceArrays.includes(field) || name.endsWith("[]") || field === "video_reference" || field === "audio_reference";
    if (multiple) {
      const list = [];
      for (const value of values) {
        const parsed = value.trim().startsWith("[") ? parseFormJSON(value, name) : value;
        if (Array.isArray(parsed)) list.push(...parsed);
        else list.push(parsed);
      }
      const target = Object.prototype.hasOwnProperty.call(canvasArrays, field) ? field + "[]" : field;
      appendReferences(req, target, list);
    } else {
      if (values.length !== 1) throw new Error(name + " must be provided once");
      req[name] = name === "metadata" || (name === "input_reference" && values[0].trim().startsWith("{"))
        ? parseFormJSON(values[0], name) : values[0];
    }
  }
  return normalizeCanvasRequest(req);
}

function validateReferences(req) {
  const singles = ["image", "image_url", "reference_video", "video_url", "input_video", "audio_url", "input_audio"];
  const arrays = referenceArrays;
  for (const field of singles) {
    if (req[field] !== undefined) requirePublicUrl(req[field], field);
  }
  for (const field of arrays) {
    if (req[field] === undefined) continue;
    if (!Array.isArray(req[field])) throw new Error(field + " must be an array");
    for (const value of req[field]) requirePublicUrl(value, field);
  }
  if (req.input_reference !== undefined) {
    const value = isObject(req.input_reference) ? req.input_reference.image_url : req.input_reference;
    requirePublicUrl(value, "input_reference");
  }
}

function validateRequest(req) {
  if (!isObject(req)) throw new Error("Request body must be an object");
  if (!trimmed(req.prompt)) throw new Error("field prompt is required");
  for (const key of ["seconds", "duration"]) {
    if (req[key] === undefined) continue;
    const seconds = Number(req[key]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
      throw new Error(key + " must be between 1 and 3600");
  }
  validateReferences(req);
}

function hasReference(req) {
  return Boolean(
    req.input_reference || req.image || req.image_url || req.reference_video || req.video_url || req.input_video || req.audio_url || req.input_audio ||
    ["images", "image_urls", "reference_images", "reference_image_urls", "videos", "video_urls", "reference_videos", "audios", "audio_urls"]
      .some(function (key) { return Array.isArray(req[key]) && req[key].length > 0; })
  );
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  validateRequest(req);
  if ((ctx.files || []).length) throw new Error("QIQI reference media must use public URLs");
  const model = trimmed(ctx.upstreamModel || ctx.model || req.model);
  if (!model) throw new Error("model is required");
  return {
    url: endpoint(ctx, "/videos"),
    method: "POST",
    headers: Object.assign(authHeaders(ctx), { "Content-Type": "application/json" }),
    body: Object.assign({}, req, { model }),
  };
}

export function parseSubmitResponse(ctx, response) {
  requireSuccess(response, response && response.body, "submission");
  const raw = response && response.body;
  const body = taskBody(raw);
  const taskId = trimmed(body.id || body.task_id);
  if (!taskId) throw new Error("QIQI response has no task ID");
  return { taskId, taskData: raw };
}

export function buildQueryRequest(ctx) {
  const taskId = trimmed(ctx.taskId);
  if (!taskId) throw new Error("QIQI upstream task ID is missing");
  return {
    url: endpoint(ctx, "/videos/" + encodeURIComponent(taskId)),
    method: "GET",
    headers: authHeaders(ctx),
  };
}

export function parseTaskResult(ctx, responseBody, response) {
  requireSuccess(response, responseBody, "polling");
  const body = taskBody(responseBody);
  const statuses = {
    queued: "QUEUED",
    pending: "QUEUED",
    processing: "IN_PROGRESS",
    in_progress: "IN_PROGRESS",
    completed: "SUCCESS",
    failed: "FAILURE",
    cancelled: "FAILURE",
    canceled: "FAILURE",
  };
  const name = trimmed(body.status).toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(statuses, name) ? statuses[name] : "UNKNOWN";
  const result = { status };
  const progress = Number(trimmed(body.progress).replace(/%$/, ""));
  if (body.progress !== undefined && Number.isFinite(progress) && progress >= 0 && progress <= 100)
    result.progress = progress + "%";
  if (status === "SUCCESS") result.progress = "100%";
  if (status === "FAILURE") result.reason = errorMessage(body) || "QIQI video generation failed";
  if (status === "UNKNOWN") result.reason = "unrecognized status: " + name;
  const url = trimmed(body.video_url || body.url);
  if (status === "SUCCESS" && /^https?:\/\//i.test(url)) result.url = url;
  return result;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

function directVideoUrl(data) {
  const body = taskBody(data);
  const url = trimmed(body.video_url || body.url);
  // QIQI's authenticated content endpoint is not a credentialless file URL.
  return /^https?:\/\/[^\s]+$/i.test(url) && !/\/v1\/videos\/[^/?]+\/content(?:[?#]|$)/i.test(url) ? url : "";
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = directVideoUrl(ctx.data);
  if (url) return { url, method: "GET", credentialless: true };
  const taskId = trimmed(ctx.upstreamTaskId);
  if (!taskId) throw new Error("QIQI upstream task ID is missing");
  return {
    url: endpoint(ctx, "/videos/" + encodeURIComponent(taskId) + "/content"),
    method: "GET",
    headers: authHeaders(ctx),
  };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const seconds = Number(req.seconds || req.duration || 15);
  const size = meta.usageSchema.size.enum.includes(trimmed(req.size)) ? trimmed(req.size) : "1280x720";
  return { seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 15, size };
}

export function extractUsageOnComplete(task, taskResult, responseBody) {
  const body = taskBody(responseBody);
  const facts = {};
  const seconds = Number(body.seconds || body.duration || 0);
  if (Number.isFinite(seconds) && seconds > 0) facts.seconds = Math.min(seconds, 3600);
  const size = trimmed(body.size);
  if (meta.usageSchema.size.enum.includes(size)) facts.size = size;
  return facts;
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      const req = decodeBody(ctx);
      req.model = ctx.model;
      validateRequest(req);
      return {
        kind: "submit",
        model: ctx.model,
        action: hasReference(req) ? "image_to_video" : "text_to_video",
        requestBody: req,
      };
    },
    render: function (ctx, task) {
      const statuses = {
        NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued",
        IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed",
      };
      const output = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || "",
        status: statuses[task.status] || "unknown",
        progress: Number(trimmed(task.progress || "0").replace(/%$/, "")),
        created_at: Number(task.created_at || 0),
      };
      const url = task.status === "SUCCESS" ? directVideoUrl(task.data) : "";
      if (url) output.metadata = { canvas_video_result: { version: 1, url } };
      if (["SUCCESS", "FAILURE"].includes(task.status)) {
        const completedAt = Number(task.finished_at || task.updated_at || 0);
        if (completedAt > 0) output.completed_at = completedAt;
      }
      if (task.status === "FAILURE")
        output.error = { code: "video_generation_failed", message: task.fail_reason || "The video generation task failed." };
      return output;
    },
  },
};
