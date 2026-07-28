import { defineConfig } from "@playwright/test";

const e2eEnv = prepareE2eDatabaseEnv();
const webServerEnv = toWebServerEnv({ ...process.env, ...e2eEnv });
const port = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    env: webServerEnv,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

function prepareE2eDatabaseEnv(): Record<string, string> {
  const databaseUrl = process.env.DOFE_AGENT_TEST_DATABASE_URL?.trim() || process.env.DOFE_AGENT_PG_TEST_URL?.trim();
  if (!databaseUrl) throw new Error("E2E requires DOFE_AGENT_TEST_DATABASE_URL or DOFE_AGENT_PG_TEST_URL.");
  return {
    DOFE_AGENT_E2E: "1",
    DOFE_AGENT_TEST_DATABASE_URL: databaseUrl,
    DOFE_AGENT_PG_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
  };
}

function toWebServerEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
