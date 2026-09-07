export const meta = {
  apiVersion: 1,
  key: "paipu",
  name: "paipu",
  icon: "text:PA",
  description: {
    en: "Paipu video API with signed, credentialless video downloads.",
  },
  version: "1.1.0",
  author: { name: "Custom" },
  // Public Paipu model IDs avoid the built-in Sora routing bindings.
  models: [
    "lec-gt-seedance-2-0-mini",
    "lec-gt-seedance-2-0-full",
    "lec-gt-seedance-2-5-720p",
    "lec-h3video-2k",
    "lec-minimax-h3",
    "lec-minimax-h3-768p",
    "lec-seed-2-0-900",
    "lec-seed-2-5-900",
    "lec-ac-seedance-2-5-480p",
    "lec-ac-seedance-2-5-900",
    "lec-ac-seedance-2-5-all-reference",
    "lec-ac-seedance-2-5-vid",
    "lec-ac-seedance-900-720p",
    "lec-ac-seedance-2-0-fast-2-720p",
    "lec-bk-video-30s",
    "lec-seedance-2-5-ht-30s",
    "lec-yu25-grok-video-1-5-preview",
    "lec-seedance-2-0-933-stable",
    "lec-ty-seedance-2-0-full",
    "lec-ty-seedance-2-0-fast",
    "lec-ty-seedance-2-0-full-933-me-720p",
    "lec-ty-seedance-2-0-full-933-pix-720p",
    "lec-seedance-2-0-full-933-1080p",
    "lec-seedance-2-0-super-933-1080p",
    "lec-seedance-2-0-mini-c4-480p",
    "lec-seedance-2-5-30s",
    "lec-seedance-2-0-pro-c8-720p",
    "lec-seedance-2-0-fast-c8-720p",
    "lec-mj-seedance-2-0-full-933",
    "lec-mj-wan-3-0-1080p",
    "lec-vg-seedance-2-5",
    "lec-yj-seedance-2-5-30s",
    "lec-wan3-720p",
    "lec-md-seedance-2-0-900-720p",
    "lec-gongteng-dola-seedance-2-0-4-15s",
  ],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds." },
    },
    size: {
      enum: ["720x1280", "1280x720", "1792x1024", "1024x1792"],
      description: { en: "Requested output video dimensions." },
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
  if (!key) throw new Error("Paipu channel API key is missing");
  return { Authorization: "Bearer " + key };
}

function taskBody(value) {
  let body = isObject(value) ? value : {};
  // Also accept an upstream data envelope without confusing it with a TaskView.
  for (let i = 0; i < 3 && !body.status && isObject(body.data); i++) body = body.data;
  return body;
}

function videoUrl(body) {
  const data = taskBody(body);
  const url = trimmed(data.url || data.video_url);
  return /^https?:\/\//i.test(url) ? url : "";
}

function expiredPaipuSignature(url) {
  if (!/[?&]signature=[^&#]+/.test(url)) return false;
  const match = /[?&]expires=(\d+)(?:&|#|$)/.exec(url);
  if (!match) return false;
  const now = typeof utils !== "undefined" && typeof utils.unixNow === "function"
    ? utils.unixNow() : Math.floor(Date.now() / 1000);
  return Number(match[1]) <= now + 30;
}

function validateRequest(req) {
  if (!isObject(req)) throw new Error("Request body must be an object");
  if (!trimmed(req.prompt)) throw new Error("field prompt is required");
  for (const key of ["seconds", "duration"]) {
    if (req[key] === undefined) continue;
    const n = Number(req[key]);
    if (!Number.isFinite(n) || n <= 0 || n > 3600)
      throw new Error(key + " must be between 1 and 3600");
  }
  if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
  if (req.metadata !== undefined && !isObject(req.metadata)) throw new Error("metadata must be an object");
}

function imageAction(req, hasFile) {
  return hasFile || req.input_reference || req.image || (req.images || []).length || ((req.metadata || {}).canvas_video || {}).media?.some(item => item.type === "image")
    ? "image_to_video" : "text_to_video";
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  validateRequest(req);
  if (ctx.action === "remix") throw new Error("Paipu remix is not supported by this plugin");
  const body = Object.assign({}, req, { model: ctx.upstreamModel || ctx.model || req.model });
  const headers = authHeaders(ctx);
  const url = endpoint(ctx, "/videos");
  if (body.model === "lec-seed-2-0-900") {
    headers["Content-Type"] = "application/json";
    return { url, method: "POST", headers, body: buildLecSeedBody(body, ctx.files || []) };
  }
  if ((req.metadata || {}).canvas_video !== undefined) throw new Error("Canvas video v1 is not implemented for upstream model: " + body.model);
  if ((ctx.files || []).length) {
    const parts = [];
    for (const key of Object.keys(body)) {
      const value = body[key];
      if (value !== undefined && value !== null)
        parts.push({ name: key, value: typeof value === "object" ? JSON.stringify(value) : value });
    }
    for (const file of ctx.files)
      parts.push({ name: file.field, fileRef: file.ref, filename: file.filename });
    return { url, method: "POST", headers, bodyType: "multipart", parts };
  }
  headers["Content-Type"] = "application/json";
  return { url, method: "POST", headers, body };
}

function buildLecSeedBody(req, files) {
  const extension = (req.metadata || {}).canvas_video;
  const allowed = new Set(["model", "prompt", "seconds", "size", "input_reference", "metadata", "images", "aspect_ratio"]);
  for (const key of Object.keys(req)) if (!allowed.has(key)) throw new Error("Unsupported LEC Seed field: " + key);
  // The historical LEC endpoint has a fixed duration; do not silently discard
  // a different requested duration or bill it as a different number of seconds.
  if (req.seconds !== undefined && Number(req.seconds) !== 15) throw new Error("LEC Seed 900 requires 15 seconds");
  let aspect = req.aspect_ratio || "16:9";
  if (req.size !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(trimmed(req.size));
    if (!match) throw new Error("LEC Seed requires a valid size");
    const width = Number(match[1]), height = Number(match[2]);
    if (width * 9 === height * 16) aspect = "16:9";
    else if (width * 16 === height * 9) aspect = "9:16";
    else throw new Error("LEC Seed supports only 16:9 or 9:16");
    if (Math.min(width, height) !== 720) throw new Error("LEC Seed 900 supports 720p only");
  }
  if (!["16:9", "9:16"].includes(aspect)) throw new Error("LEC Seed supports only 16:9 or 9:16");
  let images = req.images || [];
  if (extension !== undefined) {
    if (!isObject(extension) || extension.version !== 1 || !Array.isArray(extension.media)) throw new Error("Invalid Canvas video v1 metadata");
    if (req.images || req.input_reference || files.length) throw new Error("Cannot mix Canvas media and legacy references");
    images = extension.media.map(item => {
      if (!isObject(item) || item.type !== "image" || item.role !== "reference") throw new Error("LEC Seed supports reference images only; no frames, video or audio");
      return item.url;
    });
  }
  if (req.input_reference !== undefined) {
    if (images.length || files.length) throw new Error("Cannot mix reference input formats");
    images = [req.input_reference];
  }
  for (const file of files) {
    if (file.field !== "input_reference" || files.length !== 1 || images.length) throw new Error("Only one input_reference file is supported");
    images = [{ __fileRef: file.ref, encoding: "dataUrl", mimeType: file.mimeType || "image/png", maxBytes: 20 * 1024 * 1024 }];
  }
  if (images.length > 9) throw new Error("LEC Seed supports at most 9 reference images");
  for (const image of images) {
    if (isObject(image) && image.__fileRef) continue;
    if (typeof image !== "string" || !/^(https:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i.test(image)) throw new Error("Reference images must be HTTPS URLs or image data URLs");
  }
  return { model: req.model, prompt: req.prompt, aspect_ratio: aspect, ...(images.length ? { images } : {}) };
}

export function parseSubmitResponse(ctx, resp) {
  if (resp.statusCode && (resp.statusCode < 200 || resp.statusCode >= 300))
    throw new Error("Paipu submission failed with HTTP " + resp.statusCode);
  const body = taskBody(resp.body);
  const taskId = trimmed(body.id || body.task_id);
  if (!taskId) throw new Error("Paipu response has no task ID");
  return { taskId, taskData: resp.body };
}

export function buildQueryRequest(ctx) {
  // In query hooks taskId is the upstream ID; publicTaskId belongs to NewAPI.
  const id = trimmed(ctx.taskId);
  if (!id) throw new Error("Paipu upstream task ID is missing");
  return { url: endpoint(ctx, "/videos/" + encodeURIComponent(id)), method: "GET", headers: authHeaders(ctx) };
}

export function parseTaskResult(ctx, responseBody) {
  const body = taskBody(responseBody);
  const statuses = {
    queued: "QUEUED", pending: "QUEUED",
    processing: "IN_PROGRESS", in_progress: "IN_PROGRESS",
    completed: "SUCCESS", succeeded: "SUCCESS", success: "SUCCESS",
    failed: "FAILURE", cancelled: "FAILURE", canceled: "FAILURE",
  };
  const name = trimmed(body.status).toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(statuses, name) ? statuses[name] : "UNKNOWN";
  const result = { status };
  if (status === "UNKNOWN") result.reason = "unrecognized status: " + name;
  const progress = Number(trimmed(body.progress).replace(/%$/, ""));
  if (body.progress !== undefined && Number.isFinite(progress) && progress >= 0 && progress <= 100)
    result.progress = progress + "%";
  if (status === "SUCCESS") result.progress = "100%";
  if (status === "FAILURE")
    result.reason = trimmed(isObject(body.error) ? body.error.message : body.error) || "Paipu video generation failed";
  const url = videoUrl(body);
  if (status === "SUCCESS" && url) result.url = url;
  // The host persists responseBody in task.data for buildContentRequest.
  return result;
}

export function listArtifacts(task) {
  // URLs are injected by NewAPI. TaskArtifact does not accept a URL property.
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = videoUrl(ctx.data);
  if (url && !expiredPaipuSignature(url)) {
    // Keep the complete signature. No headers/body are allowed in this mode.
    // NewAPI forwards Range and safely follows public cross-origin redirects.
    return { url, method: "GET", credentialless: true };
  }
  // Content hooks expose the NewAPI ID as taskId, so NEVER use it here.
  const id = trimmed(ctx.upstreamTaskId);
  if (!id) throw new Error("Paipu upstream task ID is missing");
  // This fallback supports direct 200/206 responses. Credentialed cross-origin
  // redirects remain subject to the host restriction; JS cannot refresh URLs.
  return {
    url: endpoint(ctx, "/videos/" + encodeURIComponent(id) + "/content"),
    method: "GET",
    headers: authHeaders(ctx),
  };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const seconds = Number(req.seconds || req.duration || ((ctx.upstreamModel || ctx.model || req.model) === "lec-seed-2-0-900" ? 15 : 4));
  return {
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 4,
    size: req.size || "720x1280",
  };
}

export function extractUsageOnComplete(task, taskResult, responseBody) {
  const body = taskBody(responseBody);
  const facts = {};
  const seconds = Number(body.seconds || body.duration || 0);
  if (Number.isFinite(seconds) && seconds > 0) facts.seconds = Math.min(seconds, 3600);
  if (meta.usageSchema.size.enum.includes(trimmed(body.size))) facts.size = trimmed(body.size);
  return facts;
}

function decodeVideo(ctx) {
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("JSON or multipart body required");
  let req, hasFile = false;
  if (ctx.body.kind === "json") {
    if (!isObject(ctx.body.value)) throw new Error("JSON object required");
    req = Object.assign({}, ctx.body.value);
  } else {
    req = {};
    for (const name of Object.keys(ctx.body.fields || {})) {
      const values = ctx.body.fields[name];
      if (values.length !== 1) throw new Error(name + " must be provided once");
      req[name] = values[0];
    }
    for (const name of ["metadata", "images", "videos", "audios"]) {
      if (req[name] === undefined) continue;
      try { req[name] = JSON.parse(req[name]); }
      catch (e) { throw new Error(name + " must be valid JSON"); }
    }
    for (const file of ctx.body.files || []) {
      if (file.field !== "input_reference") throw new Error("unexpected file field: " + file.field);
      if (hasFile || req.input_reference !== undefined) throw new Error("input_reference must be provided once");
      hasFile = true;
    }
  }
  validateRequest(req);
  req.model = ctx.model;
  return { kind: "submit", model: ctx.model, action: imageAction(req, hasFile), requestBody: req };
}

export const protocols = {
  openai_video: {
    decodeRequest: decodeVideo,
    render: function (ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = {
        id: task.task_id, object: "video",
        model: (task.properties || {}).origin_model_name || "",
        status: statuses[task.status] || "unknown",
        progress: Number(trimmed(task.progress || "0").replace(/%$/, "")),
        created_at: Number(task.created_at || 0),
      };
      if (["SUCCESS", "FAILURE"].includes(task.status)) {
        const completedAt = Number(task.finished_at || task.updated_at || 0);
        if (completedAt > 0) output.completed_at = completedAt;
      }
      if (task.status === "FAILURE")
        output.error = { code: "video_generation_failed", message: "The video generation task failed." };
      return output;
    },
  },
};
