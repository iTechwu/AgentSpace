import { defineConfig } from "../../../../apps/web/node_modules/@playwright/test/index.mjs";

export default defineConfig({
  testDir: "../../../../apps/web/e2e",
  timeout: 30_000,
  workers: 2,
  retries: 0,
  outputDir: "./playwright-artifacts",
  reporter: [["list"], ["json", { outputFile: "./playwright-results.json" }]],
  use: {
    baseURL: "https://agentspace.local.dofe.ai",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
