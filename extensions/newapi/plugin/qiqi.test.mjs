import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./qiqi.js', import.meta.url), 'utf8');
const qiqi = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const ctx = {
  baseUrl: 'https://pidoi.com',
  apiKey: 'test-key',
  model: 'sora-v4-pro',
  upstreamModel: 'sora-v4-pro',
  taskId: 'task/upstream',
  upstreamTaskId: 'task/upstream',
  artifactKey: 'video',
  clientRequest: { method: 'GET' },
};

test('completed rendering exposes the signed file URL in the canvas metadata contract', () => {
  const url = 'https://asset.example/result.mp4?X-Amz-Signature=keep%2Bexact&X-Amz-Expires=259200';
  const task = { task_id: 'public-id', status: 'SUCCESS', data: { status: 'completed', video_url: url } };
  const rendered = qiqi.protocols.openai_video.render({}, task);
  assert.deepEqual(rendered.metadata.canvas_video_result, { version: 1, url });
  assert.equal(qiqi.protocols.openai_video.render({}, { ...task, status: 'IN_PROGRESS' }).metadata, undefined);
  assert.equal(qiqi.protocols.openai_video.render({}, { ...task, data: { video_url: 'https://pidoi.com/v1/videos/task/content' } }).metadata, undefined);
  assert.deepEqual(qiqi.buildContentRequest({ ...ctx, data: task.data }), { url, method: 'GET', credentialless: true });
});

const documentedModels = [
  'chengfeng-3.0',
  'chengfeng-480p-pro',
  'chengfeng-720p-pro',
  'H3video-2k',
  'sora-v4-pro',
  'tejiasd',
  'tejiasd2',
];

test('registers as an independent QIQI task plugin with the documented models', () => {
  assert.equal(qiqi.meta.key, 'qiqi');
  assert.equal(qiqi.meta.name, 'QIQI');
  assert.equal(qiqi.meta.channelTypes, undefined);
  assert.deepEqual(qiqi.meta.models, documentedModels);
  assert.equal(new Set(qiqi.meta.models).size, documentedModels.length);
  assert.deepEqual(qiqi.meta.protocols, ['openai_video']);
});

test('preserves the complete stock Sora JSON request and applies channel model mapping', () => {
  const request = {
    model: 'sora-v4-pro',
    prompt: 'keep the subject consistent',
    seconds: 15,
    size: '1280x720',
    input_reference: { image_url: 'https://example.com/person.jpg' },
    reference_image_urls: ['https://example.com/ref.jpg'],
    reference_videos: ['https://example.com/motion.mp4'],
    audio_urls: ['https://example.com/music.mp3'],
    generateAudio: true,
  };
  const decoded = qiqi.protocols.openai_video.decodeRequest({
    model: request.model,
    body: { kind: 'json', value: request },
  });
  const sent = qiqi.buildSubmitRequest({
    ...ctx,
    ...decoded,
    upstreamModel: 'provider-model',
    files: [],
  });

  assert.equal(sent.url, 'https://pidoi.com/v1/videos');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.headers, {
    Authorization: 'Bearer test-key',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(sent.body, { ...request, model: 'provider-model' });
});

test('normalizes channel base URLs and encodes provider task IDs', () => {
  for (const baseUrl of ['https://pidoi.com', 'https://pidoi.com/', 'https://pidoi.com/v1/']) {
    assert.equal(qiqi.buildSubmitRequest({
      ...ctx,
      baseUrl,
      requestBody: { model: ctx.model, prompt: 'test' },
    }).url, 'https://pidoi.com/v1/videos');
    assert.equal(qiqi.buildQueryRequest({ ...ctx, baseUrl }).url,
      'https://pidoi.com/v1/videos/task%2Fupstream');
  }
});

test('parses submit responses and rejects HTTP or malformed responses', () => {
  assert.deepEqual(qiqi.parseSubmitResponse({}, {
    statusCode: 200,
    body: { id: 'task-1', status: 'processing' },
  }), {
    taskId: 'task-1',
    taskData: { id: 'task-1', status: 'processing' },
  });
  assert.throws(() => qiqi.parseSubmitResponse({}, {
    statusCode: 401,
    body: { error: { message: 'bad key' } },
  }), /HTTP 401.*bad key/);
  assert.throws(() => qiqi.parseSubmitResponse({}, { statusCode: 200, body: {} }), /task ID/);
});

test('maps every documented task state and never treats HTTP errors as queued', () => {
  assert.deepEqual(qiqi.parseTaskResult({}, { status: 'queued', progress: 0 }, { status: 200 }), {
    status: 'QUEUED', progress: '0%',
  });
  assert.deepEqual(qiqi.parseTaskResult({}, { status: 'processing', progress: 42 }, { status: 200 }), {
    status: 'IN_PROGRESS', progress: '42%',
  });
  assert.deepEqual(qiqi.parseTaskResult({}, { status: 'in_progress', progress: '43%' }, { status: 200 }), {
    status: 'IN_PROGRESS', progress: '43%',
  });
  assert.deepEqual(qiqi.parseTaskResult({}, {
    status: 'completed', progress: 100,
    video_url: 'https://pidoi.com/v1/videos/task-1/content',
  }, { status: 200 }), {
    status: 'SUCCESS', progress: '100%',
    url: 'https://pidoi.com/v1/videos/task-1/content',
  });
  assert.equal(qiqi.parseTaskResult({}, {
    status: 'failed', error: { message: 'rejected' },
  }, { status: 200 }).reason, 'rejected');
  assert.equal(qiqi.parseTaskResult({}, { status: 'future' }, { status: 200 }).status, 'UNKNOWN');
  assert.throws(() => qiqi.parseTaskResult({}, {
    status: 'queued', error: { message: 'gateway unavailable' },
  }, { status: 503 }), /HTTP 503.*gateway unavailable/);
});

test('downloads completed videos through the authenticated QIQI content endpoint', () => {
  assert.deepEqual(qiqi.listArtifacts({ status: 'QUEUED' }), []);
  assert.deepEqual(qiqi.listArtifacts({ status: 'SUCCESS' }), [
    { key: 'video', type: 'video', mimeType: 'video/mp4' },
  ]);
  assert.deepEqual(qiqi.buildContentRequest(ctx), {
    url: 'https://pidoi.com/v1/videos/task%2Fupstream/content',
    method: 'GET',
    headers: { Authorization: 'Bearer test-key' },
  });
  assert.throws(() => qiqi.buildContentRequest({ ...ctx, artifactKey: 'thumbnail' }), /artifact_not_found/);
});

test('uses the documented upstream GET when New API serves a downstream HEAD request', () => {
  assert.equal(qiqi.buildContentRequest({
    ...ctx,
    clientRequest: { method: 'HEAD' },
  }).method, 'GET');
});

const decodeForm = (fields, files = []) => qiqi.protocols.openai_video.decodeRequest({
  model: ctx.model, body: { kind: 'multipart', fields: { prompt: ['test'], ...fields }, files },
});

test('converts repeated canvas URL fields into QIQI JSON without fetching media', () => {
  const decoded = decodeForm({
    seconds: ['15'], 'input_reference[]': ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    'video_reference[]': ['https://example.com/v.mp4'], 'audio_reference[]': ['https://example.com/a.mp3'],
    resolution_name: ['720p'],
  });
  const sent = qiqi.buildSubmitRequest({ ...ctx, ...decoded });
  assert.equal(decoded.action, 'image_to_video');
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.deepEqual(sent.body.reference_image_urls, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
  assert.deepEqual(sent.body.reference_videos, ['https://example.com/v.mp4']);
  assert.deepEqual(sent.body.audio_urls, ['https://example.com/a.mp3']);
  assert.equal(sent.body.resolution, '720p');
  assert.equal(sent.body['input_reference[]'], undefined);
});

test('accepts stock URL fields and JSON-encoded arrays in forms', () => {
  const req = decodeForm({ input_reference: ['https://example.com/a.jpg'],
    reference_image_urls: ['["https://example.com/b.jpg","https://example.com/c.jpg"]'] }).requestBody;
  assert.equal(req.input_reference, 'https://example.com/a.jpg');
  assert.deepEqual(req.reference_image_urls, ['https://example.com/b.jpg', 'https://example.com/c.jpg']);
  assert.equal(decodeForm({ input_reference: ['{"image_url":"https://example.com/a.jpg"}'] }).action, 'image_to_video');
});

test('rejects actual files, bad arrays, repeated scalar fields and non-URL references', () => {
  assert.throws(() => decodeForm({}, [{ field: 'input_reference' }]), /file uploads/);
  assert.throws(() => decodeForm({ seconds: ['5', '10'] }), /provided once/);
  assert.throws(() => decodeForm({ 'input_reference[]': ['blob:local'] }), /public HTTP/);
  assert.throws(() => decodeForm({ reference_image_urls: ['[broken'] }), /valid JSON/);
  assert.throws(() => decodeForm({ last_frame_url: ['https://example.com/last.jpg'] }), /last.frame/);
});

test('maps Canvas v1 media and first frames without losing unrelated metadata', () => {
  const decoded = qiqi.protocols.openai_video.decodeRequest({ model: ctx.model, body: { kind: 'json', value: {
    prompt: 'test', metadata: { custom: 'keep', canvas_video: { version: 1, media: [
      { type: 'image', role: 'first_frame', url: 'https://example.com/a.jpg' },
      { type: 'video', role: 'reference', url: 'https://example.com/v.mp4' },
      { type: 'audio', role: 'reference', url: 'https://example.com/a.mp3' },
    ] } },
  } } });
  assert.equal(decoded.action, 'image_to_video');
  assert.equal(decoded.requestBody.image_url, 'https://example.com/a.jpg');
  assert.deepEqual(decoded.requestBody.reference_videos, ['https://example.com/v.mp4']);
  assert.deepEqual(decoded.requestBody.audio_urls, ['https://example.com/a.mp3']);
  assert.deepEqual(decoded.requestBody.metadata, { custom: 'keep' });
});

test('validates required request fields without stripping vendor extensions', () => {
  assert.throws(() => qiqi.protocols.openai_video.decodeRequest({
    model: ctx.model,
    body: { kind: 'json', value: { model: ctx.model } },
  }), /prompt/);
  assert.throws(() => qiqi.protocols.openai_video.decodeRequest({
    model: ctx.model,
    body: { kind: 'json', value: { model: ctx.model, prompt: 'test', seconds: 0 } },
  }), /seconds/);
  assert.throws(() => qiqi.buildSubmitRequest({
    ...ctx,
    apiKey: '',
    requestBody: { model: ctx.model, prompt: 'test' },
  }), /API key/);
});

test('requires public HTTP(S) URLs for documented reference media fields', () => {
  const decode = (extra) => qiqi.protocols.openai_video.decodeRequest({
    model: ctx.model,
    body: { kind: 'json', value: { model: ctx.model, prompt: 'test', ...extra } },
  });
  assert.doesNotThrow(() => decode({ input_reference: { image_url: 'https://example.com/input.jpg' } }));
  assert.doesNotThrow(() => decode({ reference_videos: ['http://example.com/input.mp4'] }));
  assert.throws(() => decode({ input_reference: 'data:image/png;base64,AAAA' }), /public HTTP\(S\) URL/);
  assert.throws(() => decode({ reference_image_urls: ['C:\\input.jpg'] }), /public HTTP\(S\) URL/);
  assert.throws(() => decode({ audio_urls: 'https://example.com/input.mp3' }), /must be an array/);
});
