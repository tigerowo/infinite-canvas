import { expect, test, type Page, type Route } from "@playwright/test";

const authStorageKey = "infinite-canvas-auth-token-v1";
const token = "playwright-mock-token";
const timestamp = "2026-01-01T00:00:00Z";

const user = {
    id: "playwright-user",
    username: "playwright",
    displayName: "Playwright 用户",
    avatarUrl: "",
    role: "admin",
    credits: 100,
    createdAt: timestamp,
    updatedAt: timestamp,
};

const connectedProvider = {
    id: "mock-openai",
    kind: "api",
    protocol: "openai",
    name: "Mock OpenAI",
    baseUrl: "https://provider.invalid",
    hasApiKey: true,
    apiKeyMasked: "mock-••••",
    hasHeaders: false,
    headerNames: [],
    capabilities: ["text", "image"],
    models: ["mock-text"],
    defaultModel: "mock-text",
    timeout: 30,
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    connectionStatus: "connected",
    statusMessage: "Mock 已连接",
    lastCheckedAt: timestamp,
    executable: "",
    workingDirectory: "",
    version: "",
    createdAt: timestamp,
    updatedAt: timestamp,
};

type ProviderHandler = (route: Route) => Promise<void>;
type ApiMockHandlers = {
    migrationPreview?: ProviderHandler;
    migrate?: ProviderHandler;
    userConfig?: ProviderHandler;
    providerAction?: ProviderHandler;
};

async function respond(route: Route, data: unknown, status = 200, msg = "") {
    await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ code: status >= 400 ? 1 : 0, data, msg }),
    });
}

async function seedSession(page: Page) {
    await page.addInitScript(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify({ state: { token: value }, version: 0 })),
        { key: authStorageKey, value: token },
    );
}

async function openProvidersFromHydratedLoginPage(page: Page) {
    await page.goto("/login");
    const providerLink = page.getByRole("link", { name: "连接中心" });
    if (!(await providerLink.isVisible())) await page.getByRole("button", { name: "打开导航菜单" }).click();
    await providerLink.click();
    await expect(page.getByRole("heading", { name: "连接中心" })).toBeVisible({ timeout: 15_000 });
}

async function installApiMocks(page: Page, providerHandler: ProviderHandler = (route) => respond(route, []), handlers: ApiMockHandlers = {}) {
    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;

        if (path === "/api/settings") {
            await respond(route, { auth: { allowRegister: true, linuxDo: { enabled: false } }, modelChannel: { allowCustomChannel: true, channels: [], availableModels: [] } });
            return;
        }
        if (path === "/api/auth/login") {
            await respond(route, { token, user });
            return;
        }
        if (path === "/api/auth/me") {
            await respond(route, user);
            return;
        }
        if (path === "/api/v1/user-config") {
            if (handlers.userConfig) await handlers.userConfig(route);
            else await respond(route, { syncCapabilities: { userData: false, workflows: false, assets: false } });
            return;
        }
        if (path === "/api/v1/providers/migration-preview") {
            if (handlers.migrationPreview) await handlers.migrationPreview(route);
            else await respond(route, { total: 0, importable: 0, reusable: 0, invalid: 0, plaintextSecrets: 0, items: [] });
            return;
        }
        if (path === "/api/v1/providers/migrate" && handlers.migrate) {
            await handlers.migrate(route);
            return;
        }
        if (path === "/api/v1/providers") {
            await providerHandler(route);
            return;
        }
        if (path.startsWith("/api/v1/providers/") && handlers.providerAction) {
            await handlers.providerAction(route);
            return;
        }
        if (path === "/api/v1/user-data/assets") {
            await respond(route, []);
            return;
        }
        if (path === "/api/v1/canvas/projects") {
            await respond(route, []);
            return;
        }
        if (["/api/v1/generation-logs/images", "/api/v1/generation-logs/videos", "/api/v1/canvas/image-tasks", "/api/v1/video-tasks"].includes(path)) {
            await respond(route, []);
            return;
        }

        throw new Error(`未 Mock 的 API 请求：${request.method()} ${path}`);
    });
}

test("通过 Mock 登录提交并持久化会话", async ({ page }) => {
    await installApiMocks(page);

    await page.goto("/login?redirect=%2Fproviders");
    const username = page.getByLabel("用户名");
    const password = page.getByLabel("密码");
    await expect(username).toBeEditable();
    await username.fill("playwright");
    await password.fill("mock-password");
    await expect(username).toHaveValue("playwright");
    await expect(password).toHaveValue("mock-password");
    const loginResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login");
    await page.locator("form").getByRole("button", { name: /登\s*录/ }).click();

    await loginResponse;
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").state?.token || "", authStorageKey)).toBe(token);
});

test("连接列表从加载状态进入 API 空状态", async ({ page }) => {
    let releaseProviders = () => {};
    const providersReady = new Promise<void>((resolve) => {
        releaseProviders = resolve;
    });
    await seedSession(page);
    await installApiMocks(page, async (route) => {
        await providersReady;
        await respond(route, []);
    });

    await openProvidersFromHydratedLoginPage(page);
    await expect(page.locator('section[aria-busy="true"]')).toBeVisible();
    await expect(page.getByText("—", { exact: true })).toHaveCount(2);

    releaseProviders();
    await expect(page.getByText("还没有 API 渠道")).toBeVisible();
    await expect(page.getByRole("button", { name: "添加第一个 API" })).toBeVisible();
});

test("连接列表读取失败后可通过重试恢复空状态", async ({ page }) => {
    let providerMode: "error" | "empty" = "error";
    let providerRequests = 0;
    await seedSession(page);
    await installApiMocks(page, async (route) => {
        providerRequests += 1;
        if (providerMode === "error") {
            await respond(route, null, 503, "模拟连接列表读取失败");
            return;
        }
        await respond(route, []);
    });

    await openProvidersFromHydratedLoginPage(page);
    await expect(page.getByText("模拟连接列表读取失败")).toBeVisible();
    const requestsBeforeRetry = providerRequests;
    providerMode = "empty";
    await page.getByRole("button", { name: /重\s*试/ }).click();

    await expect(page.getByText("还没有 API 渠道")).toBeVisible();
    await expect.poll(() => providerRequests).toBeGreaterThan(requestsBeforeRetry);
});

test("390px 使用卡片、无横向溢出并在确认后停用连接", async ({ page }) => {
    let activeProvider = { ...connectedProvider };
    let updateEnabled: boolean | undefined;
    const disabledProvider = { ...connectedProvider, id: "mock-disabled", name: "Mock 已禁用", enabled: false, isDefault: false, connectionStatus: "disabled" };
    const unavailableProvider = { ...connectedProvider, id: "mock-unavailable", name: "Mock 不可用", isDefault: false, connectionStatus: "unavailable" };
    await seedSession(page);
    await installApiMocks(page, async (route) => {
        if (route.request().method() === "POST") {
            const input = route.request().postDataJSON() as { enabled?: boolean };
            updateEnabled = input.enabled;
            activeProvider = { ...activeProvider, enabled: input.enabled !== false, connectionStatus: input.enabled === false ? "disabled" : "connected" };
            await respond(route, activeProvider);
            return;
        }
        await respond(route, [activeProvider, disabledProvider, unavailableProvider]);
    });
    await page.setViewportSize({ width: 390, height: 884 });

    await openProvidersFromHydratedLoginPage(page);
    await expect(page.getByRole("switch", { name: "停用Mock OpenAI" })).toBeVisible();
    await expect(page.locator(".ant-table-wrapper")).toBeHidden();
    await expect(page.locator("article").filter({ has: page.getByRole("switch", { name: "启用Mock 已禁用" }) }).getByText("已禁用", { exact: true })).toBeVisible();
    await expect(page.locator("article").filter({ has: page.getByRole("switch", { name: "停用Mock 不可用" }) }).getByText("不可用", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("switch", { name: "停用Mock OpenAI" }).click();
    await expect(page.getByRole("dialog", { name: "停用「Mock OpenAI」？" })).toBeVisible();
    await expect(page.getByText("连接配置和已加密凭据会保留，可随时重新启用。", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /确\s*认\s*停\s*用/ }).click();

    await expect.poll(() => updateEnabled).toBe(false);
    await expect(page.getByRole("switch", { name: "启用Mock OpenAI" })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".ant-table-wrapper")).toBeVisible();
});

test("新增 API 抽屉校验模型配置并保存连接", async ({ page }) => {
    let savedInput: Record<string, unknown> | undefined;
    const createdProvider = {
        ...connectedProvider,
        id: "mock-created",
        name: "浏览器 Mock API",
        baseUrl: "https://mock-provider.invalid",
        models: ["mock-image"],
        defaultModel: "mock-image",
        connectionStatus: "untested",
        statusMessage: "",
        isDefault: false,
    };
    await seedSession(page);
    await installApiMocks(page, async (route) => {
        if (route.request().method() === "POST") {
            savedInput = route.request().postDataJSON() as Record<string, unknown>;
            await respond(route, createdProvider);
            return;
        }
        await respond(route, []);
    });

    await openProvidersFromHydratedLoginPage(page);
    await page.getByRole("button", { name: "添加第一个 API" }).click();
    const drawer = page.getByRole("dialog", { name: "新增连接" });
    await expect(drawer).toBeVisible();
    await page.getByRole("button", { name: /保\s*存/ }).click();
    await expect(drawer.getByText("请输入连接名称")).toBeVisible();

    const protocol = drawer.getByLabel("协议类型");
    await protocol.click();
    await page.getByText("通用 HTTP", { exact: true }).last().click();
    await expect(drawer.getByText("通用 HTTP adapter")).toBeVisible();
    await expect(drawer.getByLabel("Base URL")).toHaveValue("");
    await page.getByRole("button", { name: /保\s*存/ }).click();
    await expect(drawer.getByText("请输入 Base URL")).toBeVisible();
    await protocol.click();
    await page.getByText("OpenAI 兼容", { exact: true }).last().click();
    await expect(drawer.getByText("通用 HTTP adapter")).toBeHidden();

    await drawer.getByLabel("连接名称").fill("浏览器 Mock API");
    await drawer.getByLabel("Base URL").fill("https://mock-provider.invalid");
    await drawer.getByLabel("API Key").fill("playwright-secret");
    const models = drawer.getByLabel("模型列表");
    await models.fill("mock-image");
    await models.press("Enter");
    await drawer.getByLabel("默认模型").click();
    await page.getByText("mock-image", { exact: true }).last().click();
    await page.getByRole("button", { name: /保\s*存/ }).click();

    await expect(drawer).toBeHidden();
    await expect(page.getByText("浏览器 Mock API", { exact: true }).first()).toBeVisible();
    expect(savedInput).toMatchObject({
        kind: "api",
        protocol: "openai",
        name: "浏览器 Mock API",
        baseUrl: "https://mock-provider.invalid",
        apiKey: "playwright-secret",
        models: ["mock-image"],
        defaultModel: "mock-image",
    });
});

test("编辑、测试、复制并删除已有连接", async ({ page }) => {
    let deleted = false;
    let testRequests = 0;
    await seedSession(page);
    await installApiMocks(page, (route) => respond(route, deleted ? [] : [connectedProvider]), {
        providerAction: async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (path === "/api/v1/providers/mock-openai/test") {
                testRequests += 1;
                await respond(route, { status: "connected", message: "Mock 连接成功", models: ["mock-text"], checkedAt: timestamp });
                return;
            }
            if (path === "/api/v1/providers/mock-openai" && request.method() === "DELETE") {
                deleted = true;
                await respond(route, true);
                return;
            }
            throw new Error(`未 Mock 的连接操作：${request.method()} ${path}`);
        },
    });

    await openProvidersFromHydratedLoginPage(page);
    await page.getByRole("button", { name: "Mock OpenAI 操作" }).click();
    await page.getByRole("menuitem", { name: "编辑" }).click();
    const editDrawer = page.getByRole("dialog", { name: "编辑连接" });
    await expect(editDrawer).toBeVisible();
    await expect(editDrawer.getByLabel("连接名称")).toHaveValue("Mock OpenAI");
    await expect(editDrawer.getByLabel("API Key")).toHaveValue("");
    await editDrawer.getByRole("button", { name: "测试并拉取模型" }).click();
    await expect.poll(() => testRequests).toBe(1);
    await editDrawer.getByRole("button", { name: /取\s*消/ }).click();

    await page.getByRole("button", { name: "Mock OpenAI 操作" }).click();
    await page.getByRole("menuitem", { name: "复制" }).click();
    const copyDrawer = page.getByRole("dialog", { name: "新增连接" });
    await expect(copyDrawer.getByLabel("连接名称")).toHaveValue("Mock OpenAI 副本");
    await expect(copyDrawer.getByLabel("API Key")).toHaveValue("");
    await copyDrawer.getByRole("button", { name: /取\s*消/ }).click();

    await page.getByRole("button", { name: "Mock OpenAI 操作" }).click();
    await page.getByRole("menuitem", { name: "删除" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "删除「Mock OpenAI」？" });
    await expect(deleteDialog.getByText("密钥删除后无法恢复", { exact: false })).toBeVisible();
    await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();

    await expect.poll(() => deleted).toBe(true);
    await expect(page.getByText("还没有 API 渠道")).toBeVisible();
});

test("迁移预览展示风险并按确认选项提交", async ({ page }) => {
    let migrated = false;
    let migrateInput: Record<string, unknown> | undefined;
    const preview = {
        total: 3,
        importable: 1,
        reusable: 1,
        invalid: 1,
        plaintextSecrets: 2,
        items: [
            { sourceId: "legacy-new", name: "旧生图渠道", protocol: "openai", baseUrl: "https://legacy.invalid", models: ["legacy-image"], hasApiKey: true, action: "import" },
            { sourceId: "legacy-reuse", name: "旧复用渠道", protocol: "gemini", baseUrl: "https://reuse.invalid", models: ["legacy-text"], hasApiKey: true, action: "reuse", existingProviderId: "mock-openai" },
            { sourceId: "legacy-invalid", name: "旧无效渠道", protocol: "openai", baseUrl: "", models: [], hasApiKey: false, action: "invalid", issue: "缺少 Base URL" },
        ],
    };
    await seedSession(page);
    await installApiMocks(page, undefined, {
        migrationPreview: (route) => respond(route, migrated ? { total: 0, importable: 0, reusable: 0, invalid: 0, plaintextSecrets: 0, items: [] } : preview),
        migrate: async (route) => {
            migrateInput = route.request().postDataJSON() as Record<string, unknown>;
            migrated = true;
            await respond(route, { importedCount: 1, reusedCount: 1, cleanedSecrets: 2, mappings: [], providers: [] });
        },
    });

    await openProvidersFromHydratedLoginPage(page);
    await expect(page.getByText("发现 3 个旧版本地渠道")).toBeVisible();
    await page.getByRole("button", { name: "预览迁移" }).click();
    const modal = page.getByRole("dialog", { name: "迁移旧版渠道" });
    await expect(modal.getByText("旧生图渠道")).toBeVisible();
    await expect(modal.getByText("旧复用渠道")).toBeVisible();
    await expect(modal.getByText("旧无效渠道")).toBeVisible();
    await expect(modal.getByText("新建连接", { exact: true })).toBeVisible();
    await expect(modal.getByText("复用并去重", { exact: true })).toBeVisible();
    await expect(modal.getByText("需手动修正", { exact: true })).toBeVisible();
    await modal.getByRole("checkbox", { name: /导入后清理旧配置/ }).check();
    await expect(modal.getByText("预计清理最多 2 个渠道中的旧明文密钥", { exact: false })).toBeVisible();
    await modal.getByRole("button", { name: "确认迁移" }).click();

    await expect(modal).toBeHidden();
    await expect(page.getByText("发现 3 个旧版本地渠道")).toBeHidden();
    expect(migrateInput).toEqual({ cleanupLegacy: true });
});

test("连接中心模型进入生图台和视频台选择器", async ({ page }) => {
    const creativeProvider = {
        ...connectedProvider,
        id: "mock-creative",
        name: "Mock 创作渠道",
        capabilities: ["image", "video"],
        models: ["mock-image", "mock-video"],
        defaultModel: "mock-image",
    };
    await seedSession(page);
    await installApiMocks(page, (route) => respond(route, [creativeProvider]), {
        userConfig: (route) => respond(route, { modelConfig: { channelMode: "remote" }, syncCapabilities: { userData: false, workflows: false, assets: false } }),
    });

    await page.goto("/image");
    const imagePicker = page.locator('[data-slot="select-trigger"]').filter({ hasText: "mock-image" }).first();
    await expect(imagePicker).toBeVisible({ timeout: 15_000 });
    await imagePicker.click();
    await expect(page.getByRole("option", { name: /mock-image.*Mock 创作渠道/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/video");
    const videoPicker = page.locator('[data-slot="select-trigger"]').filter({ hasText: "mock-video" }).first();
    await expect(videoPicker).toBeVisible({ timeout: 15_000 });
    await videoPicker.click();
    await expect(page.getByRole("option", { name: /mock-video.*Mock 创作渠道/ })).toBeVisible();
});

test("连接中心图片模型进入无限画布配置节点选择器", async ({ page }) => {
    test.setTimeout(60_000);
    const canvasProvider = {
        ...connectedProvider,
        id: "mock-canvas",
        name: "Mock 画布渠道",
        capabilities: ["image"],
        models: ["mock-canvas-image"],
        defaultModel: "mock-canvas-image",
    };
    await seedSession(page);
    await installApiMocks(page, (route) => respond(route, [canvasProvider]), {
        userConfig: (route) => respond(route, { modelConfig: { channelMode: "remote" }, syncCapabilities: { userData: false, workflows: false, assets: false } }),
    });

    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "无限画布" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "新建画布" }).last().click();
    const enteredDirectly = await Promise.race([
        page.waitForURL(/\/canvas\/[^/]+$/, { timeout: 30_000 }).then(() => true).catch(() => false),
        page.getByRole("button", { name: /无限画布 1.*0 个节点/ }).waitFor({ state: "visible" }).then(() => false),
    ]);
    if (!enteredDirectly) {
        await page.getByRole("button", { name: /无限画布 1.*0 个节点/ }).click();
        await expect(page).toHaveURL(/\/canvas\/[^/]+$/, { timeout: 30_000 });
    }
    await page.getByRole("button", { name: "生成配置" }).click();

    const canvasPicker = page.locator('[data-slot="select-trigger"]').filter({ hasText: "mock-canvas-image" }).first();
    await expect(canvasPicker).toBeVisible({ timeout: 15_000 });
    await canvasPicker.click();
    await expect(page.getByRole("option", { name: /mock-canvas-image.*Mock 画布渠道/ })).toBeVisible();
});

test("Antigravity CLI 可进入画布文本目录且即梦展示受控账户能力", async ({ page }) => {
    test.setTimeout(60_000);
    const canvasProvider = {
        ...connectedProvider,
        id: "mock-canvas-api",
        name: "Mock 画布 API",
        capabilities: ["image"],
        models: ["mock-canvas-api-image"],
        defaultModel: "mock-canvas-api-image",
    };
    const geminiCLIProvider = {
        ...connectedProvider,
        id: "mock-gemini-cli",
        kind: "cli",
        protocol: "gemini-cli",
        name: "Mock Antigravity CLI",
        baseUrl: "",
        hasApiKey: false,
        capabilities: ["text"],
        models: ["gemini-3.5-flash-low"],
        defaultModel: "gemini-3.5-flash-low",
        executable: "/mock/agy",
        version: "agy 1.2.3",
        isDefault: false,
    };
    const jimengCLIProvider = {
        ...connectedProvider,
        id: "mock-jimeng-cli",
        kind: "cli",
        protocol: "jimeng",
        name: "Mock 即梦 CLI",
        baseUrl: "",
        hasApiKey: false,
        capabilities: ["image", "video"],
        models: ["mock-jimeng-cli-image"],
        defaultModel: "mock-jimeng-cli-image",
        executable: "/mock/dreamina",
        version: "dreamina 1.4.2",
        isDefault: false,
    };
    const providers = [canvasProvider, geminiCLIProvider, jimengCLIProvider];
    const detectedProtocols: string[] = [];
    await seedSession(page);
    await installApiMocks(page, (route) => respond(route, providers), {
        userConfig: (route) => respond(route, { modelConfig: { channelMode: "remote" }, syncCapabilities: { userData: false, workflows: false, assets: false } }),
        providerAction: async (route) => {
            const path = new URL(route.request().url()).pathname;
            const provider = providers.find((item) => path === `/api/v1/providers/${item.id}/cli/detect`);
            if (!provider || provider.kind !== "cli") throw new Error(`未 Mock 的 CLI 操作：${route.request().method()} ${path}`);
            detectedProtocols.push(provider.protocol);
            await respond(route, { available: true, protocol: provider.protocol, executable: provider.executable, version: provider.version, message: "CLI 检测成功" });
        },
    });

    await openProvidersFromHydratedLoginPage(page);
    await page.getByRole("tab", { name: "CLI 渠道" }).click();
    for (const provider of [geminiCLIProvider, jimengCLIProvider]) {
        await page.getByRole("button", { name: `${provider.name} 操作` }).click();
        await page.getByRole("menuitem", { name: "编辑" }).click();
        const drawer = page.getByRole("dialog", { name: "编辑连接" });
        if (provider.protocol === "gemini-cli") {
            await expect(drawer.getByText("Antigravity CLI 受控接入")).toBeVisible();
            await expect(drawer.getByRole("button", { name: "检查登录状态" })).toBeVisible();
            await expect(drawer.getByRole("button", { name: "最小调用" })).toBeVisible();
        } else {
            await expect(drawer.getByText("即梦 CLI 受控接入")).toBeVisible();
            await expect(drawer.getByRole("button", { name: "检查登录状态" })).toBeVisible();
            await expect(drawer.getByRole("button", { name: "最小调用" })).toHaveCount(0);
            await expect(drawer.getByRole("region", { name: "即梦账户概览" })).toBeVisible();
            await expect(drawer.getByText("积分消费明细")).toBeVisible();
        }
        await drawer.getByRole("button", { name: "检测 CLI" }).click();
        await expect.poll(() => detectedProtocols.filter((protocol) => protocol === provider.protocol).length).toBe(1);
        await drawer.getByRole("button", { name: /取\s*消/ }).click();
    }

    expect(detectedProtocols).toEqual(["gemini-cli", "jimeng"]);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "无限画布" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "新建画布" }).last().click();
    const enteredDirectly = await Promise.race([
        page.waitForURL(/\/canvas\/[^/]+$/, { timeout: 30_000 }).then(() => true).catch(() => false),
        page.getByRole("button", { name: /无限画布 1.*0 个节点/ }).waitFor({ state: "visible" }).then(() => false),
    ]);
    if (!enteredDirectly) {
        await page.getByRole("button", { name: /无限画布 1.*0 个节点/ }).click();
        await expect(page).toHaveURL(/\/canvas\/[^/]+$/, { timeout: 30_000 });
    }
    await page.getByRole("button", { name: "生成配置" }).click();

    const canvasPicker = page.locator('[data-slot="select-trigger"]').filter({ hasText: "mock-canvas-api-image" }).first();
    await expect(canvasPicker).toBeVisible({ timeout: 15_000 });
    await canvasPicker.click();
    await expect(page.getByRole("option", { name: /mock-canvas-api-image.*Mock 画布 API/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /gemini-3.5-flash-low/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /mock-jimeng-cli-image.*Mock 即梦 CLI/ })).toBeVisible();
});
