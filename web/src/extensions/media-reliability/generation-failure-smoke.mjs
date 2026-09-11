import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.EXT_MEDIA_RELIABILITY_TEST_URL || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ headless: true });
const video = fs.readFileSync(process.env.EXT_CANVAS_TEST_VIDEO);
const portrait = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="teal"/></svg>');
const models = ['gpt-image-1', 'sora-2'];
const channel = { id: 'fixture', name: 'Fixture', protocol: 'newapi', baseUrl: 'https://fixture.invalid', models, enabled: true };
const config = { channelMode: 'remote', baseUrl: channel.baseUrl, systemPrompt: '', systemPrompts: { video: '', image: '' }, models, model: 'gpt-image-1', imageModel: 'gpt-image-1', videoModel: 'sora-2', apiMode: 'images', count: '1', videoSeconds: '6', imageChannelId: 'fixture', videoChannelId: 'fixture' };
const now = new Date().toISOString();
const timeout = 'generate status=408 code=timeout_error message=system under load';
const reference = { id: 'ref', name: '参考图.svg', type: 'image/svg+xml', storageKey: 'server:reference', dataUrl: '' };
const histories = { videos: [{ id: 'success-video', prompt: '成功参考恢复', title: '成功参考恢复', createdAt: Date.now()-10000, model: 'sora-2', config, references: [reference], videoReferences: [], audioReferences: [], status: '成功', video: { id: 'video', url: '', storageKey: 'server:video', width: 90, height: 160, durationMs: 6000 }, durationMs: 6000 }], images: [{ id: 'success-image', prompt: '图片参考恢复', title: '图片参考恢复', createdAt: Date.now()-10000, model: 'gpt-image-1', config, references: [reference], status: '成功', images: [{ id: 'portrait', storageKey: 'server:reference', dataUrl: '', width: 100, height: 100, mimeType: 'image/svg+xml' }], errors: [], errorDetails: [], successCount: 1, imageCount: 1, failCount: 0, durationMs: 6000 }] };
const tasks = new Map();
let projects = [{ id: 'failure', title: '失败同步', createdAt: now, updatedAt: now, nodes: [{ id: 'video', type: 'video', position: { x: 150, y: 150 }, width: 280, height: 160, metadata: { model: 'sora-2', channelId: 'fixture', status: 'loading', startedAt: 1, videoTaskId: 'client_video_task_old', progress: 0, prompt: '失败视频' } }], connections: [], chatSessions: [], viewport: { x: 0, y: 0, k: 1 }, sidePanel: { open: false, width: 280 }, agentPanel: { open: false, width: 400 } }];
const errors = [], requests = [];
let releaseStale, staleHeld = false, imageQueryOffline = false;
const stale = new Promise(resolve => { releaseStale = resolve; });
const wait = async (check, label) => {
    for (let i = 0; i < 350; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(label);
};
async function page(label) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    await context.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        requests.push({ label, path, method: req.method() });
        const ok = data => route.fulfill({ json: { code: 0, data } });
        if (path === '/api/auth/me') return ok({ id: 'fixture', username: 'fixture', role: 'admin', credits: 100 });
        if (path === '/api/settings') return ok({ modelChannel: { enabled: true, availableModels: models, allowUserRemoteChannel: true, channels: [channel], modelCosts: [], systemPrompt: '', systemPrompts: { image: '', video: '' } }, site: {} });
        if (path === '/api/v1/user-config') return ok({ modelConfig: config, syncCapabilities: { userData: true } });
        if (path === '/api/extensions/model-policy') return ok({ imageTransfer: 'url', overrides: {}, newapiVideoProfiles: { 'fixture::sora-2': 'canvas-v1' } });
        if (path === '/api/v1/canvas/projects' && req.method() === 'POST') {
            const { data, base_updated_at } = req.postDataJSON();
            if (base_updated_at !== projects[0].updatedAt) return route.fulfill({ json: { code: 1, msg: '画布版本已更新，请重新同步' } });
            projects = [data]; return ok(data);
        }
        if (path === '/api/v1/canvas/projects' || path === '/api/v1/canvas/projects/sync') return ok(projects);
        if (path === '/api/v1/videos/client_video_task_old') {
            if (label === 'canvas-a' && !staleHeld) { staleHeld = true; await stale; return ok({ id: 'client_video_task_old', status: 'queued', progress: 0 }); }
            return ok({ id: 'client_video_task_old', status: 'failed', error: { message: timeout } });
        }
        if (path.includes('storage/config')) return ok({ mode: 'server_sqlite_s3', allowUserGlobalProvider: true, autoSyncAllAssets: true });
        if (path.endsWith('/signed-url') || path.endsWith('/url')) {
            const id = path.split('/').at(-2);
            return ok({ url: `https://media.fixture.invalid/${id}`, expiresAt: new Date(Date.now()+86400000).toISOString(), mimeType: id === 'video' ? 'video/webm' : 'image/svg+xml' });
        }
        if (path === '/api/v1/files' && req.method() === 'POST') return ok({ id: 'reference', storageKey: 'server:reference', url: 'https://media.fixture.invalid/reference', mimeType: 'image/svg+xml', width: 90, height: 160 });
        if (path === '/api/v1/videos' && req.method() === 'POST') {
            const id = req.headers()['x-client-video-task-id'];
            tasks.set(id, { id, task_id: id, status: 'failed', model: 'sora-2', source: 'video-workbench', channelId: 'fixture', request_body: req.postData(), created_at: now, error: { message: timeout } });
            return route.fulfill({ json: { code: 1, msg: timeout } });
        }
        if (path === '/api/v1/video-tasks') return ok([...tasks.values()]);
        if (path.startsWith('/api/v1/generation-logs/')) {
            const kind = path.split('/')[4];
            if (req.method() === 'POST') for (const log of req.postDataJSON().logs || []) histories[kind] = [log, ...histories[kind].filter(x => x.id !== log.id)];
            return ok(histories[kind]);
        }
        if (path === '/api/v1/canvas/image-tasks/status') {
            if (imageQueryOffline) return route.fulfill({ status: 503, json: { code: 1, msg: 'fixture temporary unavailable' } });
            return ok([{ id: 'image-task', status: 'failed', error: { message: timeout } }]);
        }
        if (/prompts|assets/.test(path)) return ok({ items: [], total: 0, assets: [] });
        return ok([]);
    });
    await context.route('https://media.fixture.invalid/**', route => route.fulfill({ contentType: route.request().url().endsWith('/video') ? 'video/webm' : 'image/svg+xml', body: route.request().url().endsWith('/video') ? video : portrait }));
    await context.addInitScript(config => {
        localStorage.setItem('infinite-canvas-auth-token-v1', JSON.stringify({ state: { token: 'fixture' }, version: 0 }));
        localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config }, version: 0 }));
    }, config);
    const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); return p;
}
try {
    const a = await page('canvas-a'), b = await page('canvas-b');
    await a.goto(origin+'/canvas/failure');
    await wait(() => staleHeld, 'first canvas poll not held');
    await b.goto(origin+'/canvas/failure');
    await b.locator('[data-node-id="video"]').getByText(timeout, { exact: true }).waitFor();
    await a.locator('[data-node-id="video"]').getByText(timeout, { exact: true }).waitFor();
    releaseStale();
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(await a.locator('[data-node-id="video"]').getByText(timeout, { exact: true }).count(), 1);
    await a.reload();
    await a.locator('[data-node-id="video"]').getByText(timeout, { exact: true }).waitFor();

    const v1 = await page('video-a'), v2 = await page('video-b');
    await Promise.all([v1.goto(origin+'/video'), v2.goto(origin+'/video')]);
    await v1.getByRole('button', { name: /^载\s*入$/ }).first().click();
    await wait(() => v1.locator('img[alt="参考图.svg"]').evaluateAll(imgs => imgs.some(i => i.complete && i.naturalWidth === 90)), 'loaded reference did not resolve OSS/cache');
    await wait(() => v1.locator('video').first().evaluate(v => v.videoWidth > 0 && Math.abs(v.parentElement.getBoundingClientRect().width / v.parentElement.getBoundingClientRect().height - v.videoWidth/v.videoHeight)<.02), 'video did not adapt to decoded ratio');
    await v1.getByPlaceholder('描述镜头运动、主体动作、场景氛围和画面风格').first().fill('跨浏览器失败');
    await v1.getByRole('button', { name: /^(开始创作|开始生成)$/ }).first().click();
    await wait(() => histories.videos.some(h => h.status === '失败' && h.error === timeout), 'failed creation not synced to account history');
    await v2.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(() => v2.getByText(timeout, { exact: true }).count().then(n => n > 0), 'other browser did not restore failure');
    await v2.reload();
    await wait(() => v2.getByText(timeout, { exact: true }).count().then(n => n > 0), 'failure lost on reload');
    const referenceLoads = requests.filter(r => r.path === '/api/v1/files' && r.method === 'POST');
    assert.equal(referenceLoads.length, 0, 'existing OSS reference uploaded again');

    const i = await page('image');
    await i.goto(origin+'/image');
    await i.getByRole('button', { name: /^载\s*入$/ }).first().click();
    await wait(() => i.locator('img[alt="参考图.svg"]').evaluateAll(imgs => imgs.some(x => x.complete && x.naturalWidth === 90)), 'image workbench reference load failed');
    await wait(() => i.locator('img[alt^="历史结果"]').first().evaluate(el => { const box=el.closest('[style*="aspect-ratio"]').getBoundingClientRect(); return Math.abs(box.width/box.height-9/16)<.02; }), 'image ratio not adaptive');
    imageQueryOffline = true;
    histories.images.unshift({ id: 'pending-image', prompt: '查询恢复测试', createdAt: Date.now(), config, model: 'gpt-image-1', references: [], images: [], errors: [], status: '生成中', task: { id: 'image-task', source: 'image-workbench', status: 'processing' } });
    await i.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(() => i.getByText(/任务状态暂不可用，将自动重试/).count().then(n => n > 0), 'image query error hidden');
    assert.equal(histories.images.find(h => h.id === 'pending-image').status, '生成中', 'temporary lookup failure became terminal');
    imageQueryOffline = false;
    await wait(() => histories.images.some(h => h.id === 'pending-image' && h.status === '失败' && h.errors?.[0] === timeout), 'image polling did not recover and persist upstream failure');
    const i2 = await page('image-other');
    await i2.goto(origin+'/image');
    await wait(() => i2.getByText(timeout, { exact: true }).count().then(n => n > 0), 'image failure missing in other browser');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks: ['late queued cannot revive failure', 'canvas failure across browsers and reload', 'video creation failure synced to another browser', 'OSS reference load and cache without reupload', 'video decoded aspect ratio', 'image reference load and portrait aspect ratio', 'image lookup error visible and recoverable', 'image terminal failure synced across browsers'] }));
} catch (error) {
    console.error(JSON.stringify({ errors, requests: requests.slice(-25), pages: await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async p => ({ url: p.url(), text: (await p.locator('body').innerText()).slice(-3500) }))) }));
    throw error;
} finally { releaseStale?.(); await browser.close(); }
