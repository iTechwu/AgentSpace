import { defineConfig } from "../../../../apps/web/node_modules/@playwright/test/index.mjs";

const baseURL = process.env.PLAYWRIGHT_BASE_URL?.trim() || "https://agentspace.local.dofe.ai";

export default defineConfig({
  testDir: "../../../../apps/web/e2e",
  timeout: 30_000,
  workers: 2,
  retries: 0,
  outputDir: "./playwright-artifacts",
  reporter: [["list"], ["json", { outputFile: "./playwright-results.json" }]],
  use: {
    baseURL,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
