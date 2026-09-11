import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.EXT_MEDIA_RELIABILITY_CHROMIUM || undefined });
const origin = process.env.EXT_MEDIA_RELIABILITY_TEST_URL || 'http://127.0.0.1:3001';
const videoBytes = fs.readFileSync(process.env.EXT_CANVAS_TEST_VIDEO);
const user = { id: 'sync-fixture', username: 'fixture', role: 'admin', credits: 100 };
const models = ['gpt-image-1', 'sora-2', 'gpt-5.5'];
const channel = { id: 'fixture', name: 'Fixture', protocol: 'newapi', baseUrl: 'https://fixture.invalid', models, enabled: true };
const config = { channelMode: 'remote', models, imageModel: 'gpt-image-1', videoModel: 'sora-2', model: 'gpt-5.5', imageChannelId: 'fixture', videoChannelId: 'fixture', localChannels: [{ ...channel, apiKey: 'fixture' }] };
const now = new Date().toISOString();
const lifecyclePolicy = { mode: 'retention', days: 30, execution: 'observe', version: 1, epoch: 1, clearing: false, storageReviewed: false, migratedAt: Date.now() };
let projects = [{ id: 'fixture', title: '同步测试画布', createdAt: now, updatedAt: now, nodes: [
    { id: 'video', type: 'video', title: '测试视频', position: { x: 100, y: 110 }, width: 180, height: 320, metadata: { status: 'success', storageKey: 'server:video', content: '', startedAt: 1 } },
    { id: 'image', type: 'image', title: '测试竖图', position: { x: 550, y: 120 }, width: 320, height: 180, metadata: { status: 'success', storageKey: 'server:image', content: '', startedAt: 1 } },
], connections: [], chatSessions: [], activeChatId: null, agentConfig: null, autoTitlePending: false, backgroundMode: 'dots', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, sidePanel: { open: false, width: 280 }, agentPanel: { open: false, width: 400 } }];
const deleted = new Set();
const errors = [];
let rejectDelete = false;
let rejectConfig = false;
let holdSave = null, releaseSave = () => {}, saveHeld = false;
async function context(loggedIn, label) {
    const ctx = await browser.newContext({ viewport: { width: 1237, height: 912 } });
    await ctx.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        const ok = data => route.fulfill({ json: { code: 0, data } });
        if (path === '/api/auth/me') return ok(user);
        if (path === '/api/settings') return ok({ modelChannel: { enabled: true, availableModels: models, allowUserRemoteChannel: true, channels: [channel], modelCosts: [], systemPrompts: {} }, site: {} });
        if (path === '/api/v1/user-config') {
            if (label === 'recovery' && rejectConfig) return route.fulfill({ status: 503, json: { code: 1, msg: '测试配置暂不可用' } });
            return ok({ modelConfig: config, syncCapabilities: { userData: true } });
        }
        if (path === '/api/v1/canvas/projects' && req.method() === 'POST') {
            const { data, base_updated_at } = req.postDataJSON();
            if (label === 'a' && holdSave) { const gate = holdSave; holdSave = null; saveHeld = true; await gate; }
            const current = projects.find(p => p.id === data.id);
            if (deleted.has(data.id) || (base_updated_at !== undefined && (current?.updatedAt || '') !== base_updated_at)) return route.fulfill({ json: { code: 1, msg: '画布版本已更新，请重新同步' } });
            projects = [...projects.filter(p => p.id !== data.id), data];
            return ok(data);
        }
        if (path === '/api/v1/canvas/projects/sync') {
            for (const p of req.postDataJSON().projects) if (!deleted.has(p.id) && !projects.some(r => r.id === p.id)) projects.push(p);
            return ok(projects);
        }
        if (path === '/api/v1/canvas/projects/delete') {
            if (rejectDelete) return route.fulfill({ status: 503, json: { code: 1, msg: '测试删除失败' } });
            req.postDataJSON().ids.forEach(id => deleted.add(id));
            projects = projects.filter(p => !deleted.has(p.id));
            return ok({ deleted: true });
        }
        if (path === '/api/v1/canvas/projects') return ok(projects);
        if (path === '/api/extensions/media-lifecycle/state') return ok(lifecyclePolicy);
        if (path.startsWith('/api/extensions/media-lifecycle/draft/')) return ok({ entity: { version: 0, lastUsedAt: Date.now() }, expiresAt: Date.now()+2592000000, epoch: 1, missing: [] });
        if (path === '/api/extensions/media-lifecycle/activity' || path === '/api/extensions/media-lifecycle/promote') return ok({ entity: { version: 1, lastUsedAt: Date.now() }, expiresAt: Date.now()+2592000000, epoch: 1, missing: [] });
        if (path.endsWith('/signed-url')) return ok({ url: path.includes('/video/') ? 'https://media.fixture.invalid/video.webm' : 'https://media.fixture.invalid/image.svg', expiresAt: new Date(Date.now()+86400000).toISOString() });
        if (path === '/api/extensions/model-policy') return ok({ imageTransfer: 'url', overrides: {}, newapiVideoProfiles: {} });
        if (path.includes('storage/config')) return ok({ mode: 'server_sqlite_s3', autoSyncAllAssets: false });
        if (path.includes('/user-data/assets')) return ok({ assets: [] });
        if (path.endsWith('/delete')) return ok({ deleted: true });
        if (/prompts|assets/.test(path)) return ok({ items: [], total: 0 });
        return ok([]);
    });
    await ctx.route('https://media.fixture.invalid/video.webm', r => r.fulfill({ contentType: 'video/webm', body: videoBytes }));
    await ctx.route('https://media.fixture.invalid/image.svg', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="teal"/></svg>' }));
    await ctx.addInitScript(({ loggedIn, config }) => {
        if (loggedIn) localStorage.setItem('infinite-canvas-auth-token-v1', JSON.stringify({ state: { token: 'fixture' }, version: 0 }));
        localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config }, version: 0 }));
    }, { loggedIn, config });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    return page;
}
const wait = async (check, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(label);
};
try {
    const a = await context(true, 'a'), b = await context(true, 'b');
    await Promise.all([a.goto(origin + '/canvas/fixture'), b.goto(origin + '/canvas/fixture')]);
    const video = a.locator('[data-node-id="video"]'), image = a.locator('[data-node-id="image"]');
    await video.waitFor();
    await wait(async () => { const v = await video.boundingBox(), i = await image.boundingBox(); return v && i && Math.abs(v.width/v.height-16/9)<.01 && Math.abs(i.width/i.height-9/16)<.01; }, 'media aspect ratio mismatch');
    await video.locator('video').click();
    await a.locator('[data-canvas-node-editor]').waitFor();
    await a.keyboard.press('Escape');
    const box = await video.boundingBox();
    await a.mouse.move(box.x+box.width/2, box.y+box.height/2);
    await a.mouse.down(); await a.mouse.move(box.x+box.width/2+100, box.y+box.height/2+40, { steps: 8 }); await a.mouse.up();
    await wait(async () => (await video.boundingBox()).x > box.x+90, 'video cannot be moved');
    await video.getByRole('button', { name: '播放', exact: true }).click();
    await wait(() => video.locator('video').evaluate(el => !el.paused), 'video controls blocked');
    await video.getByRole('button', { name: '暂停', exact: true }).click();
    await wait(() => projects[0].nodes.find(n=>n.id==='video').position.x > 150, 'move not saved');
    const moveVideo = async () => {
        const rect = await video.boundingBox();
        await a.mouse.move(rect.x+rect.width/2, rect.y+rect.height/2);
        await a.mouse.down(); await a.mouse.move(rect.x+rect.width/2+40, rect.y+rect.height/2, { steps: 8 }); await a.mouse.up();
    };
    holdSave = new Promise(resolve => { releaseSave = resolve; });
    await moveVideo();
    await wait(() => saveHeld, 'slow save fixture not reached');
    await b.locator('[data-node-id="image"]').click({ button: 'right' });
    await b.getByRole('button', { name: 'Delete', exact: true }).click();
    await wait(() => !projects[0].nodes.some(n=>n.id==='image'), 'local node deletion not saved');
    await moveVideo();
    const expectedX = (await video.boundingBox()).x;
    await new Promise(resolve => setTimeout(resolve, 650));
    releaseSave();
    await wait(() => a.locator('[data-node-id="image"]').count().then(n=>n===0), 'remote deletion lost during queued saves');
    await wait(async () => {
        const syncedVideo = await b.locator('[data-node-id="video"]').boundingBox();
        return Boolean(syncedVideo && Math.abs(syncedVideo.x-expectedX)<2);
    }, 'queued local move lost during conflict');
    await b.reload();
    await b.locator('[data-node-id="video"] video').waitFor();
    assert.equal(await b.locator('[data-node-id="image"]').count(), 0);
    assert.equal(await b.locator('[data-node-id="video"] video').evaluate(el => el.currentSrc.includes('video.webm')), true);
    await a.goto(origin+'/canvas');
    rejectDelete = true;
    await a.getByRole('button', { name: '删除', exact: true }).click();
    const deleteDialog = a.getByRole('dialog');
    await deleteDialog.waitFor();
    await deleteDialog.getByRole('button', { name: /^删\s*除$/ }).click();
    await a.getByText('测试删除失败', { exact: false }).waitFor();
    assert.equal(projects.length, 1);
    rejectDelete = false;
    if (!await deleteDialog.isVisible()) {
        await a.getByRole('button', { name: '删除', exact: true }).click();
        await deleteDialog.waitFor();
    }
    await deleteDialog.getByRole('button', { name: /^删\s*除$/ }).click();
    await wait(() => b.url().endsWith('/canvas'), 'deleted open project did not close in second browser');
    await b.reload(); assert.equal(projects.length, 0);
    const guest = await context(false);
    for (const route of ['/image','/video']) {
        await guest.goto(origin+route);
        await guest.getByRole('combobox').first().waitFor();
        assert.ok((await guest.getByRole('combobox').allTextContents()).every(t => !models.some(m => t.includes(m))), 'guest model leak');
        if (route === '/video') assert.equal(await guest.getByText('首尾帧', { exact: true }).count(), 0);
    }
    projects = [{ id: 'recovery', title: '网络恢复测试', createdAt: now, updatedAt: now, nodes: [], connections: [] }];
    rejectConfig = true;
    const recovery = await context(true, 'recovery');
    await recovery.goto(origin+'/canvas');
    await recovery.getByText(/测试配置暂不可用/).first().waitFor();
    rejectConfig = false;
    await recovery.evaluate(() => window.dispatchEvent(new Event('online')));
    await recovery.getByText('网络恢复测试', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: actual media ratios, video select/drag/playback, concurrent slow saves preserve deletion and local edits, two-browser project delete and reload, delete/config failure recovery, guest image/video model gating, no frame UI');
} catch (error) {
    console.error(error, JSON.stringify({ projects, errors }));
    process.exitCode = 1;
} finally { await browser.close(); }
