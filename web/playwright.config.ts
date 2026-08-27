import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 3100);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl || `http://127.0.0.1:${port}`;

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: "list",
    use: {
        baseURL,
        locale: "zh-CN",
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: externalBaseUrl
        ? undefined
        : {
              command: `${JSON.stringify(process.execPath)} ./node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p ${port}`,
              url: baseURL,
              reuseExistingServer: !process.env.CI,
              timeout: 120_000,
          },
});
