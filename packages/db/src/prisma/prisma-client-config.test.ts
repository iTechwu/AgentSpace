import assert from "node:assert/strict";
import test from "node:test";
import { resolveDofePrismaPoolConfig } from "./prisma-client.ts";

test("Prisma pool config uses role defaults and bounded timeouts", () => {
  assert.deepEqual(resolveDofePrismaPoolConfig({ DOFE_AGENT_PROCESS_ROLE: "daemon" }), {
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    application_name: "agentspace-daemon",
  });
});

test("Prisma pool config clamps invalid and oversized environment values", () => {
  const config = resolveDofePrismaPoolConfig({
    DOFE_AGENT_PROCESS_ROLE: "web",
    DOFE_AGENT_PRISMA_POOL_MAX: "9999",
    DOFE_AGENT_PRISMA_CONNECTION_TIMEOUT_MS: "not-a-number",
    DOFE_AGENT_PRISMA_IDLE_TIMEOUT_MS: "1",
    DOFE_AGENT_PRISMA_STATEMENT_TIMEOUT_MS: "-4",
    DOFE_AGENT_PRISMA_APPLICATION_NAME: "web role/with spaces",
  });
  assert.equal(config.max, 100);
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.idleTimeoutMillis, 1_000);
  assert.equal(config.statement_timeout, 100);
  assert.equal(config.application_name, "web-role-with-spaces");
});
