import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.EXT_MEDIA_RELIABILITY_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true, executablePath: process.env.EXT_MEDIA_RELIABILITY_CHROMIUM || undefined });
const artifactDir = process.env.EXT_MEDIA_RELIABILITY_ARTIFACT_DIR || path.join(tmpdir(), "huabu-workbench-smoke");
fs.mkdirSync(artifactDir, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1111, height: 912 } });
const page = await context.newPage();
const dropLocalImage = async (name) => page.evaluate((fileName) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pZYAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
    const target = document.querySelector("div.flex.h-full.flex-col.overflow-hidden");
    target?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, name);
const createdAt = "2026-09-10T10:00:00.000Z";
const completedAt = "2026-09-10T10:08:30.000Z";
const policy = { mode: "retention", days: 30, execution: "observe", version: 1, epoch: 1, clearing: false, storageReviewed: false, migratedAt: Date.now() };
let videoBodyRequests = 0;
let droppedUploadRequests = 0;
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

await context.addInitScript(() => {
    localStorage.setItem("infinite-canvas-auth-token-v1", JSON.stringify({ state: { token: "fixture" }, version: 0 }));
    localStorage.setItem("infinite-canvas:video-workbench-layout", "side");
});

await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const ok = (data) => route.fulfill({ json: { code: 0, data } });
    if (path === "/api/auth/me") return ok({ id: "fixture", username: "fixture", displayName: "Fixture", role: "admin", credits: 100 });
    if (path === "/api/settings") return ok({ modelChannel: { enabled: true, availableModels: ["video-model"], channels: [], modelCosts: [], systemPrompt: "", systemPrompts: {} }, site: {} });
    if (path === "/api/v1/user-config") return ok({ modelConfig: { channelMode: "remote", model: "video-model", videoModel: "video-model", size: "1280x720", vquality: "720", videoSeconds: "6", localChannels: [] }, syncCapabilities: { userData: true } });
    if (path.endsWith("/storage/config")) return ok({ mode: "server_sqlite_s3", allowUserProvider: true, allowUserGlobalProvider: true, autoSyncAllAssets: true });
    if (path === "/api/v1/video-tasks") return ok([{ id: "task-1", task_id: "task-1", status: "completed", progress: 100, model: "video-model", size: "1280x720", seconds: "6", storageKey: "server:video-file", video_url: "/api/files/video-file/content", created_at: createdAt, updated_at: completedAt, completed_at: completedAt, request_body: JSON.stringify({ prompt: "终态计时回归", model: "video-model", size: "1280x720", resolution_name: "720", seconds: "6" }) }]);
    if (path === "/api/v1/generation-logs/videos") return ok([]);
    if (path === "/api/v1/files" && request.method() === "POST") { droppedUploadRequests++; return ok({ id: "dropped-image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pZYAAAAASUVORK5CYII=", storageKey: "server:dropped-image", mimeType: "image/png", bytes: 68, width: 1, height: 1 }); }
    if (path === "/api/v1/files/video-file/signed-url") return ok({ url: "https://media.fixture.invalid/video.mp4?X-Amz-Signature=fixture&X-Amz-Credential=fixture", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), mimeType: "video/mp4" });
	    if (path === "/api/extensions/media-lifecycle/state" || path === "/api/extensions/media-lifecycle/admin/policy") return ok(policy);
	    if (path.startsWith("/api/extensions/media-lifecycle/draft/")) return ok({ entity: { version: 0, lastUsedAt: Date.now() }, expiresAt: Date.now() + 2_592_000_000, epoch: 1, missing: [] });
	    if (path === "/api/extensions/media-lifecycle/activity" || path === "/api/extensions/media-lifecycle/promote") return ok({ entity: { version: 1, lastUsedAt: Date.now() }, expiresAt: Date.now() + 2_592_000_000, epoch: 1, missing: [] });
    if (path === "/api/extensions/media-lifecycle/admin/capacity") return ok({ physicalBytes: 0, physicalFiles: 0, logicalBytes: 0, pendingBytes: 0 });
    if (path === "/api/extensions/media-lifecycle/admin/batches") return ok([]);
    if (path === "/api/extensions/model-policy") return ok({ imageTransfer: "url", overrides: {}, newapiVideoProfiles: {} });
    if (path === "/api/assets") return ok({ items: [{ id: "library-image", title: "可拖拽素材", type: "image", coverUrl: "", tags: [], category: "测试", description: "", content: "", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", createdAt, updatedAt: createdAt }], tags: [], total: 1 });
    if (path.includes("/user-data/") || path === "/api/prompts") return ok([]);
    return ok([]);
});
await page.route("https://media.fixture.invalid/**", async (route) => {
    videoBodyRequests++;
    await route.fulfill({ contentType: "video/mp4", body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) });
});

try {
    await page.goto(origin + "/asset-library");
    await page.getByText("可拖拽素材", { exact: true }).waitFor();
    assert.equal(await page.locator("[draggable=true]").count(), 1, "asset library card did not expose a drag source");

    await page.goto(origin + "/video");
    await page.getByText("参考图", { exact: true }).waitFor();
    await page.getByRole("combobox").first().waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.setData("application/x-infinite-canvas-asset", JSON.stringify({ kind: "image", dataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", title: "拖入参考图", source: "library" }));
        const target = document.querySelector("div.flex.h-full.flex-col.overflow-hidden");
        target?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    const referenceSection = page.locator("section").filter({ has: page.getByText("参考图", { exact: true }) }).first();
    await referenceSection.locator(".ant-tag").getByText("1", { exact: true }).waitFor();
    await dropLocalImage("video-local-drop.png");
    await referenceSection.locator(".ant-tag").getByText("2", { exact: true }).waitFor();
    const sideButton = page.getByRole("button", { name: "侧边", exact: true });
    assert.equal(await sideButton.getAttribute("aria-pressed"), "true");
    assert.notEqual(await sideButton.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "selected layout button stayed transparent");
    await page.getByRole("button", { name: "底部", exact: true }).click();
    const workbench = page.locator('[class*="workbench"]').first();
    assert.notEqual(await workbench.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "bottom workbench stayed transparent");
    await page.getByText("8分30秒", { exact: true }).waitFor();
    const video = page.locator("video[data-adaptive-media]").first();
    await video.waitFor();
    assert.equal(await video.getAttribute("preload"), "none");
	    await page.waitForTimeout(31_000);
	    assert.ok((await page.getByText("8分30秒", { exact: true }).count()) >= 1);
	    assert.equal(videoBodyRequests, 0, "completed video body was requested before playback");
	    await video.dispatchEvent("play");
	    await page.waitForFunction(() => new Promise((resolve) => {
	        const opened = indexedDB.open("infinite-canvas");
	        opened.onerror = () => resolve(false);
	        opened.onsuccess = () => {
	            const db = opened.result;
	            if (!db.objectStoreNames.contains("media_files")) { db.close(); resolve(false); return; }
	            const count = db.transaction("media_files", "readonly").objectStore("media_files").count();
	            count.onerror = () => { db.close(); resolve(false); };
	            count.onsuccess = () => { db.close(); resolve(count.result > 0); };
	        };
	    }));
	    assert.equal(videoBodyRequests, 1, "playback did not cache the completed video exactly once");
	    await page.reload();
	    await page.getByText("8分30秒", { exact: true }).waitFor();
	    await page.waitForTimeout(500);
	    assert.equal(videoBodyRequests, 1, "reopening the page downloaded an already cached video again");

	    await page.goto(origin + "/image");
	    await page.getByText("参考图", { exact: true }).waitFor();
	    await page.getByRole("combobox").first().waitFor();
	    await page.waitForTimeout(500);
	    await dropLocalImage("image-local-drop.png");
	    const imageReferenceSection = page.locator("section").filter({ has: page.getByText("参考图", { exact: true }) }).first();
	    await imageReferenceSection.locator(".ant-tag").getByText("1", { exact: true }).waitFor();
	    await page.evaluate(() => {
	        const transfer = new DataTransfer();
	        transfer.setData("application/x-infinite-canvas-asset", JSON.stringify({ kind: "image", dataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", title: "拖入生图参考", source: "library" }));
        const target = document.querySelector("div.flex.h-full.flex-col.overflow-hidden");
	        target?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
	        target?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
	    });
	    await imageReferenceSection.locator(".ant-tag").getByText("2", { exact: true }).waitFor();
	    assert.equal(droppedUploadRequests, 2, "local file drops did not archive once in each workbench");

	    await page.goto(origin + "/admin/retention");
    await page.getByText("保留规则", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "数据保留与清理", exact: true }).count(), 1);
	    await page.getByRole("checkbox", { name: /确认 OSS 不会按“上传时间”自动删除文件/ }).waitFor();
	    await page.getByText("勾选后才允许启用自动清理。请先关闭 OSS 自带的按上传时间删除规则，否则仍在使用的画布素材可能提前消失。", { exact: true }).waitFor();
	    assert.equal(await page.locator(".ant-card-bordered").count(), 0);
	    for (const width of [1111, 390]) {
	        await page.setViewportSize({ width, height: 912 });
	        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	        await page.screenshot({ path: path.join(artifactDir, `retention-dark-${width}.png`), fullPage: true });
	    }
	    await page.setViewportSize({ width: 1111, height: 912 });
	    await page.getByRole("button", { name: "切换到浅色主题" }).click();
	    await page.getByRole("button", { name: "切换到深色主题" }).waitFor();
	    await page.waitForFunction(() => !document.documentElement.classList.contains("dark") && !document.documentElement.hasAttribute("data-magicui-theme-vt"));
	    const lightSurface = await page.locator("main.ant-layout-content").evaluate((element) => getComputedStyle(element).backgroundColor);
	    assert.notEqual(lightSurface, "rgb(12, 10, 9)", "retention page stayed on the dark surface after switching themes");
	    const lightInfoSurface = await page.locator(".ant-alert-info").first().evaluate((element) => {
	        const value = getComputedStyle(element).backgroundColor;
	        const lab = value.match(/^lab\(([\d.]+)/);
	        if (lab) return Number(lab[1]);
	        const oklch = value.match(/^oklch\(([\d.]+)/);
	        if (oklch) return Number(oklch[1]) * 100;
	        const rgb = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
	        return rgb ? (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 2.55 : 0;
	    });
	    assert.ok(lightInfoSurface > 90, "retention information alert did not use a light neutral surface");
	    await page.screenshot({ path: path.join(artifactDir, "retention-light-1111.png"), fullPage: true });
	    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	    console.log("PASS: asset cards expose drag data; image/video workbenches accept asset and local-file drops; bottom selection and panel are opaque; terminal duration stayed at 8m30s; video cached only after playback and reopened from IndexedDB; retention layout passed dark/light and 1111/390 widths.");
} catch (error) {
    console.error(error, JSON.stringify({ droppedUploadRequests, pageErrors, consoleErrors, mains: await page.locator("main").evaluateAll((elements) => elements.map((element) => ({ className: element.className, parent: element.parentElement?.className }))), text: (await page.locator("body").innerText()).slice(-1800) }));
    process.exitCode = 1;
} finally {
    await browser.close();
}
