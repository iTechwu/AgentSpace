import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEffectiveRuntimeEnv } from "./repository-env.ts";

test("readEffectiveRuntimeEnv lets runtime env override repository .env when disabled", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-repository-env-"));
  const previous = {
    DOFE_AGENT_APP_URL: process.env.DOFE_AGENT_APP_URL,
    DOFE_AGENT_REPOSITORY_ENV_OVERRIDE: process.env.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE,
    DOFE_AGENT_REPOSITORY_ROOT: process.env.DOFE_AGENT_REPOSITORY_ROOT,
  };

  try {
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(join(tempRoot, ".env"), "DOFE_AGENT_APP_URL=https://production.test\n", "utf8");

    process.env.DOFE_AGENT_REPOSITORY_ROOT = tempRoot;
    process.env.DOFE_AGENT_APP_URL = "https://runtime.test";
    process.env.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE = "0";

    assert.equal(readEffectiveRuntimeEnv().DOFE_AGENT_APP_URL, "https://runtime.test");
  } finally {
    restoreEnv("DOFE_AGENT_APP_URL", previous.DOFE_AGENT_APP_URL);
    restoreEnv("DOFE_AGENT_REPOSITORY_ENV_OVERRIDE", previous.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE);
    restoreEnv("DOFE_AGENT_REPOSITORY_ROOT", previous.DOFE_AGENT_REPOSITORY_ROOT);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
