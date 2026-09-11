import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.EXT_MEDIA_RELIABILITY_TEST_URL || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ headless: true, executablePath: process.env.EXT_MEDIA_RELIABILITY_CHROMIUM || undefined });
const video = fs.readFileSync(process.env.EXT_CANVAS_TEST_VIDEO);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pZYAAAAASUVORK5CYII=', 'base64');
const models = ['gpt-image-1', 'sora-2'];
const channel = { id: 'fixture', name: 'Fixture', protocol: 'newapi', baseUrl: 'https://fixture.invalid', models, enabled: true };
const config = { channelMode: 'remote', baseUrl: channel.baseUrl, apiKey: '', systemPrompt: '', systemPrompts: { image: '', video: '' }, models, model: 'gpt-image-1', imageModel: 'gpt-image-1', videoModel: 'sora-2', apiMode: 'responses', count: '1', videoSeconds: '6', imageChannelId: 'fixture', videoChannelId: 'fixture', localChannels: [{ ...channel, apiKey: 'fixture' }] };
const captured = [], uploads = [], errors = [];
const files = new Map();
const now = new Date().toISOString();
const lifecyclePolicy = { mode: 'retention', days: 30, execution: 'observe', version: 1, epoch: 1, clearing: false, storageReviewed: false, migratedAt: Date.now() };
const referenceNodes = Array.from({ length: 51 }, (_, i) => ({ id: `ref-${i}`, type: i === 50 ? 'audio' : 'image', title: `素材 ${i}`, position: { x: 4000+i*40, y: 0 }, width: 30, height: 30, metadata: { content: `https://media.fixture.invalid/canvas-${i}`, storageKey: `server:canvas-${i}`, status: 'success' } }));
let projects = [{ id: 'limit-fixture', title: '参考总量测试', createdAt: now, updatedAt: now, nodes: [...referenceNodes, { id: 'target', type: 'video', title: '测试视频', position: { x: 200, y: 180 }, width: 240, height: 135, metadata: { content: 'https://media.fixture.invalid/canvas-video', storageKey: 'server:canvas-video', status: 'success', model: 'sora-2', prompt: 'fixture' } }], connections: referenceNodes.map(node => ({ id: node.id, fromNodeId: node.id, toNodeId: 'target' })), chatSessions: [], activeChatId: null, agentConfig: null, autoTitlePending: false, backgroundMode: 'dots', viewport: { x: 0, y: 0, k: 1 }, sidePanel: { open: false, width: 280 }, agentPanel: { open: false, width: 400 } }];
files.set('canvas-video', new File([video], 'canvas.webm', { type: 'video/webm' }));
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const ok = data => route.fulfill({ json: { code: 0, data } });
    if (path === '/api/auth/me') return ok({ id: 'fixture', username: 'fixture', role: 'admin', credits: 100 });
    if (path === '/api/settings') return ok({ modelChannel: { enabled: true, availableModels: models, allowUserRemoteChannel: true, channels: [channel], modelCosts: [], systemPrompt: '', systemPrompts: {} }, site: {} });
    if (path === '/api/v1/user-config') return ok({ modelConfig: config, syncCapabilities: { userData: true } });
    if (path === '/api/extensions/model-policy') return ok({ imageTransfer: 'url', overrides: {}, newapiVideoProfiles: { 'fixture::sora-2': 'canvas-v1' } });
    if (path === '/api/v1/canvas/projects' && req.method() === 'POST') {
        projects = [req.postDataJSON().data];
        return ok(projects[0]);
    }
    if (path === '/api/v1/canvas/projects' || path === '/api/v1/canvas/projects/sync') return ok(projects);
    if (path === '/api/extensions/media-lifecycle/state') return ok(lifecyclePolicy);
    if (path.startsWith('/api/extensions/media-lifecycle/draft/')) return ok({ entity: { version: 0, lastUsedAt: Date.now() }, expiresAt: Date.now()+2592000000, epoch: 1, missing: [] });
    if (path === '/api/extensions/media-lifecycle/activity' || path === '/api/extensions/media-lifecycle/promote') return ok({ entity: { version: 1, lastUsedAt: Date.now() }, expiresAt: Date.now()+2592000000, epoch: 1, missing: [] });
    if (path.includes('storage/config')) return ok({ mode: 'server_sqlite_s3', allowUserGlobalProvider: true, autoSyncAllAssets: true });
    if (path === '/api/v1/files' && req.method() === 'POST') {
        const data = await new Response(req.postDataBuffer(), { headers: { 'Content-Type': req.headers()['content-type'] } }).formData();
        const file = data.get('file'), id = `f${files.size}`;
        files.set(id, file); uploads.push({ name: file.name, bytes: file.size, type: file.type });
        return ok({ id, url: `https://media.fixture.invalid/${id}`, storageKey: `server:${id}`, mimeType: file.type, bytes: file.size, width: 1, height: 1 });
    }
    if (path.endsWith('/url') || path.endsWith('/signed-url')) {
        const id = path.split('/').at(-2), file = files.get(id);
        return ok({ url: `https://media.fixture.invalid/${id}`, expiresAt: new Date(Date.now()+86400000).toISOString(), mimeType: file?.type || 'image/png' });
    }
    if (req.method() === 'POST' && (path.endsWith('/videos') || path === '/api/v1/canvas/image-tasks')) {
        captured.push({ path, body: req.postDataJSON() });
        return route.fulfill({ json: { code: 1, msg: '测试已捕获请求，不执行生成' } });
    }
    if (path.includes('/user-data/assets')) return ok({ assets: [] });
    if (/prompts|assets/.test(path)) return ok({ items: [], total: 0 });
    return ok([]);
});
await context.route('https://media.fixture.invalid/**', async route => {
    const file = files.get(new URL(route.request().url()).pathname.slice(1));
    return route.fulfill({ contentType: file?.type || 'image/png', body: file ? Buffer.from(await file.arrayBuffer()) : png });
});
await context.addInitScript(config => {
    localStorage.setItem('infinite-canvas-auth-token-v1', JSON.stringify({ state: { token: 'fixture' }, version: 0 }));
    localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config }, version: 0 }));
}, config);
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const diagnostics = [];
page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
const wait = async (check, label) => {
    for (let i=0; i<300; i++) { if (await check()) return; await new Promise(r=>setTimeout(r,100)); }
    throw new Error(label);
};
try {
    const images = Array.from({ length: 50 }, (_, i) => ({ name: `image-${i}.png`, mimeType: 'image/png', buffer: png }));
    const videos = Array.from({ length: 4 }, (_, i) => ({ name: `video-${i}.webm`, mimeType: 'video/webm', buffer: video }));
    const audios = Array.from({ length: 4 }, (_, i) => ({ name: `audio-${i}.wav`, mimeType: 'audio/wav', buffer: Buffer.alloc(i === 0 ? 16*1024*1024 : 44) }));
    await page.goto(origin+'/video');
    await page.getByRole('combobox').first().waitFor();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传', exact: true }).first().click();
    await (await chooser).setFiles([...images.slice(0, 42), ...videos, ...audios]);
    await wait(() => uploads.length === 50, 'combined 50 video references were not uploaded');
    await wait(() => page.getByRole('button', { name: '移除参考图', exact: true }).count().then(n=>n===42), 'video references not attached');
    await page.locator('input[type=file]').first().setInputFiles([images[42]]);
    await page.getByText(/合计最多 50 个，当前 51 个/).first().waitFor();
    assert.equal(uploads.length, 50, '51st reference was uploaded');
    const prompt = page.getByPlaceholder('描述镜头运动、主体动作、场景氛围和画面风格').first();
    await prompt.fill('fixture');
    await page.getByRole('button', { name: /^(开始创作|开始生成)$/ }).first().click();
    await wait(() => captured.some(item=>item.path.endsWith('/videos')), 'video request not captured');
    const media = captured.find(item=>item.path.endsWith('/videos')).body.metadata.canvas_video.media;
    assert.equal(media.filter(item=>item.type==='image').length, 42);
    assert.equal(media.filter(item=>item.type==='video').length, 4);
    assert.equal(media.filter(item=>item.type==='audio').length, 4);
    assert.ok(media.every(item=>item.url.startsWith('https://media.fixture.invalid/')));
    assert.ok(uploads.some(item=>item.type==='audio/wav' && item.bytes===16*1024*1024));
    await page.goto(origin+'/image');
    await page.getByRole('combobox').first().waitFor();
    const imageChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传', exact: true }).first().click();
    await (await imageChooser).setFiles(images);
    await wait(() => page.getByRole('button', { name: '移除参考图', exact: true }).count().then(n=>n===50), 'image references not attached');
    const uploadedCount = uploads.length;
    const overflowChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传', exact: true }).first().click();
    await (await overflowChooser).setFiles([images[0]]);
    await page.getByText(/合计最多 50 个，当前 51 个/).first().waitFor();
    assert.equal(uploads.length, uploadedCount, '51st image was uploaded');
    const imagePrompt = page.locator('textarea[placeholder]').filter({ visible: true }).first();
    await imagePrompt.fill('fixture');
    await page.getByRole('button', { name: /^(开始创作|开始生成)$/ }).first().click();
    await wait(() => captured.some(item=>item.path.includes('image-tasks')), 'image request not captured');
    const imageBody = captured.find(item=>item.path.includes('image-tasks')).body;
    const serialized = JSON.stringify(imageBody);
    assert.equal((serialized.match(/"type":"input_image"/g) || []).length, 50);
    const beforeCanvas = captured.length;
    await page.goto(origin+'/canvas/limit-fixture');
    await page.locator('[data-node-id="target"] video').click();
    const editor = page.locator('[data-canvas-node-editor]');
    await editor.waitFor();
    await editor.getByRole('button', { name: '生成', exact: true }).click();
    await page.getByText(/合计最多 50 个，当前 51 个/).first().waitFor();
    assert.equal(captured.length, beforeCanvas, 'canvas sent 51 references');
    await editor.getByRole('button', { name: '断开参考连接', exact: true }).last().click();
    await wait(() => editor.getByRole('button', { name: '断开参考连接', exact: true }).count().then(n=>n===50), 'canvas reference was not removed');
    await editor.getByRole('button', { name: '生成', exact: true }).click();
    await wait(() => captured.length > beforeCanvas, 'canvas did not accept 50 references');
    assert.equal(captured.at(-1).body.metadata.canvas_video.media.length, 50);
    assert.deepEqual(errors, []);
    console.log('PASS: combined 50 references (42 images + 4 videos + 4 audios, including 16 MiB audio), 51st rejected; image and canvas 50 accepted/51 rejected; generation intercepted.');
} catch (error) {
    console.error(error, JSON.stringify({ uploads: uploads.length, captured: captured.map(item=>({path:item.path, keys:Object.keys(item.body)})), errors, diagnostics, text: (await page.locator('body').innerText()).slice(-1800) }));
    process.exitCode=1;
} finally { await browser.close(); }
