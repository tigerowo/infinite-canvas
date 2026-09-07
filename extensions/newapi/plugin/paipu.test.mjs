import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./paipu.js', import.meta.url), 'utf8');
const p = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const signed = 'https://api.paipu.net/v1/videos/task_provider/content?expires=4102444800&signature=a%2Bb%2Fc';
const ctx = {
  baseUrl: 'https://api.paipu.net', apiKey: 'test-key',
  taskId: 'task_newapi', upstreamTaskId: 'task_provider',
  artifactKey: 'video', clientRequest: { method: 'GET', headers: { Range: 'bytes=0-99' } },
  data: { status: 'completed', url: signed },
};

test('paipu registers independently of legacy channel types', () => {
  assert.equal(p.meta.key, 'paipu');
  assert.equal(p.meta.name, 'paipu');
  assert.equal(p.meta.channelTypes, undefined);
  assert.equal(p.meta.models.length, 35);
  assert.equal(new Set(p.meta.models).size, 35);
  assert.ok(!p.meta.models.some(model => model.includes('face-processing')));
  assert.ok(p.meta.models.every(model => model.startsWith('lec-')));
  assert.deepEqual(p.meta.protocols, ['openai_video']);
  assert.deepEqual(Object.keys(p.protocols), ['openai_video']);
});

test('public Paipu model IDs preserve explicit channel mappings', () => {
  for (const alias of p.meta.models) {
    const requestBody = { model: alias, prompt: 'test' };
    assert.equal(p.buildSubmitRequest({ ...ctx, model: alias, upstreamModel: alias, requestBody }).body.model,
      alias);
    assert.equal(p.buildSubmitRequest({ ...ctx, model: alias, upstreamModel: 'provider-model', requestBody }).body.model,
      'provider-model');
  }
});

test('signed content descriptor preserves signature and enables credentialless redirects', () => {
  assert.deepEqual(p.buildContentRequest(ctx), { url: signed, method: 'GET', credentialless: true });
});

test('HEAD clients use documented upstream GET; host owns downstream HEAD and Range', () => {
  assert.equal(p.buildContentRequest({ ...ctx, clientRequest: { method: 'HEAD' } }).method, 'GET');
});

test('content supports persisted response envelopes and public CDN URLs', () => {
  assert.equal(p.buildContentRequest({ ...ctx, data: { data: ctx.data } }).url, signed);
  const url = 'https://cdn.example.org/video.mp4';
  assert.deepEqual(p.buildContentRequest({ ...ctx, data: { status: 'completed', video_url: url } }),
    { url, method: 'GET', credentialless: true });
});

test('unsigned fallback uses provider ID, never the local NewAPI ID', () => {
  const descriptor = p.buildContentRequest({ ...ctx, data: {} });
  assert.equal(descriptor.url, 'https://api.paipu.net/v1/videos/task_provider/content');
  assert.deepEqual(descriptor.headers, { Authorization: 'Bearer test-key' });
  assert.throws(() => p.buildContentRequest({ ...ctx, data: {}, upstreamTaskId: '' }), /upstream task ID/);
});

test('expired Paipu signatures fall back without sending expired query parameters', () => {
  const result = p.buildContentRequest({ ...ctx, data: { status: 'completed', url: signed.replace('4102444800', '1') } });
  assert.equal(result.url, 'https://api.paipu.net/v1/videos/task_provider/content');
  assert.equal(result.headers.Authorization, 'Bearer test-key');
});

test('query uses query-context provider ID and normalizes base URL', () => {
  for (const baseUrl of ['https://api.paipu.net', 'https://api.paipu.net/', 'https://api.paipu.net/v1/']) {
    const result = p.buildQueryRequest({ ...ctx, baseUrl, taskId: 'task_provider/a', publicTaskId: 'task_newapi' });
    assert.equal(result.url, 'https://api.paipu.net/v1/videos/task_provider%2Fa');
  }
});

test('task lifecycle parses signed URL, failure, progress, and unknown statuses', () => {
  assert.deepEqual(p.parseTaskResult({}, ctx.data), { status: 'SUCCESS', progress: '100%', url: signed });
  assert.deepEqual(p.parseTaskResult({}, { status: 'in_progress', progress: '42%' }), { status: 'IN_PROGRESS', progress: '42%' });
  assert.equal(p.parseTaskResult({}, { status: 'failed', error: { message: 'example failure' } }).reason, 'example failure');
  assert.equal(p.parseTaskResult({}, { status: 'future_status' }).status, 'UNKNOWN');
  assert.equal(p.parseTaskResult({}, { status: 'constructor' }).status, 'UNKNOWN');
  assert.deepEqual(p.listArtifacts({ status: 'QUEUED' }), []);
  assert.equal(p.listArtifacts({ status: 'SUCCESS' })[0].url, undefined);
});

test('submission round-trip preserves vendor fields and channel model mapping', () => {
  const body = { model: 'sora-2', prompt: 'test', images: ['data:image/png;base64,AAAA'], duration: 5, aspect_ratio: '16:9' };
  const decoded = p.protocols.openai_video.decodeRequest({ model: 'sora-2', body: { kind: 'json', value: body } });
  const sent = p.buildSubmitRequest({ ...ctx, ...decoded, upstreamModel: 'provider-model', files: [] });
  assert.deepEqual(sent.body, { ...body, model: 'provider-model' });
  assert.deepEqual(p.parseSubmitResponse({}, { statusCode: 200, body: { id: 'task_provider' } }),
    { taskId: 'task_provider', taskData: { id: 'task_provider' } });
});

test('multipart keeps arrays and metadata instead of dropping them', () => {
  const decoded = p.protocols.openai_video.decodeRequest({ model: 'sora-2', body: {
    kind: 'multipart', fields: { prompt: ['test'], images: ['["https://example.org/image.png"]'], metadata: ['{"a":1}'] },
    files: [{ field: 'input_reference', ref: 'request_file:input_reference' }],
  } });
  const sent = p.buildSubmitRequest({ ...ctx, ...decoded, upstreamModel: 'provider-model',
    files: [{ field: 'input_reference', ref: 'request_file:input_reference' }] });
  assert.equal(sent.parts.find(x => x.name === 'images').value, '["https://example.org/image.png"]');
  assert.equal(sent.parts.find(x => x.name === 'metadata').value, '{"a":1}');
});

test('invalid input and unknown artifacts are rejected', () => {
  assert.throws(() => p.protocols.openai_video.decodeRequest({ body: { kind: 'json', value: 'bad' } }), /object/);
  assert.throws(() => p.buildSubmitRequest({ ...ctx, requestBody: { prompt: 'test', duration: -1 } }), /duration/);
  assert.throws(() => p.buildContentRequest({ ...ctx, artifactKey: 'thumbnail' }), /artifact_not_found/);
});

test('standard NewAPI request maps to LEC JSON inside the plugin', () => {
  const request = { model: 'my-video', prompt: 'test', seconds: '15', size: '720x1280', input_reference: 'data:image/png;base64,AAAA' };
  const decoded = p.protocols.openai_video.decodeRequest({ model: 'my-video', body: { kind: 'json', value: request } });
  const sent = p.buildSubmitRequest({ ...ctx, ...decoded, upstreamModel: 'lec-seed-2-0-900', files: [] });
  assert.deepEqual(sent.body, { model: 'lec-seed-2-0-900', prompt: 'test', aspect_ratio: '9:16', images: [request.input_reference] });
  assert.equal(sent.headers['Content-Type'], 'application/json');
  const other = p.buildSubmitRequest({ ...ctx, ...decoded, upstreamModel: 'provider-model', files: [] });
  assert.deepEqual(other.body, { ...request, model: 'provider-model' });
});

test('multipart reference uses host file placeholder for LEC', () => {
  const files = [{ field: 'input_reference', ref: 'file-1', mimeType: 'image/jpeg', filename: 'one.jpg' }];
  const decoded = p.protocols.openai_video.decodeRequest({ model: 'alias', body: { kind: 'multipart', fields: { prompt: ['test'], seconds: ['15'], size: ['1280x720'] }, files } });
  const sent = p.buildSubmitRequest({ ...ctx, ...decoded, upstreamModel: 'lec-seed-2-0-900', files });
  assert.equal(sent.bodyType, undefined);
  assert.deepEqual(sent.body.images[0], { __fileRef: 'file-1', encoding: 'dataUrl', mimeType: 'image/jpeg', maxBytes: 20 * 1024 * 1024 });
});

test('Canvas v1 multi-image contract transforms explicitly and rejects unsupported roles', () => {
  const media = [{ type: 'image', role: 'reference', url: 'https://example.org/a.png' }, { type: 'image', role: 'reference', url: 'data:image/png;base64,AAAA' }];
  const requestBody = { model: 'alias', prompt: 'test', seconds: '15', size: '1280x720', metadata: { canvas_video: { version: 1, media } } };
  const submit = (body, model = 'lec-seed-2-0-900') => p.buildSubmitRequest({ ...ctx, requestBody: body, upstreamModel: model });
  assert.deepEqual(submit(requestBody).body.images, media.map(item => item.url));
  for (const role of ['first_frame', 'last_frame']) assert.throws(() => submit({ ...requestBody, metadata: { canvas_video: { version: 1, media: [{ ...media[0], role }] } } }), /reference images only/);
  assert.throws(() => submit({ ...requestBody, seconds: '5' }), /15 seconds/);
  assert.throws(() => submit({ ...requestBody, size: '720x720' }), /16:9 or 9:16/);
  assert.throws(() => submit(requestBody, 'unsupported-model'), /not implemented/);
  assert.throws(() => submit({ ...requestBody, metadata: { canvas_video: { version: 2, media } } }), /Invalid Canvas/);
});
