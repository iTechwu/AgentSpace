import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadOpenMontageDevEnvironment } from "./dev-openmontage.mjs";

test("OpenMontage dev environment loads sibling secrets without copying them", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-openmontage-dev-"));
  const agentRepo = join(root, "agentspace.dofe.ai");
  const montageRepo = join(root, "OpenMontage");
  mkdirSync(agentRepo);
  mkdirSync(montageRepo);
  writeFileSync(join(agentRepo, ".env"), "DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR=./data/runtime-vault\n");
  writeFileSync(join(montageRepo, ".env"), [
    `OPENMONTAGE_SERVICE_TOKEN=${"s".repeat(32)}`,
    `OPENMONTAGE_EVENT_SIGNING_SECRET=${"e".repeat(32)}`,
    "",
  ].join("\n"));

  try {
    const environment = loadOpenMontageDevEnvironment({ repoDir: agentRepo, baseEnvironment: {} });
    assert.equal(environment.OPENMONTAGE_SERVICE_TOKEN, "s".repeat(32));
    assert.equal(environment.OPENMONTAGE_EVENT_SIGNING_SECRET, "e".repeat(32));
    assert.equal(environment.OPENMONTAGE_BASE_URL, "http://127.0.0.1:8765");
    assert.equal(environment.DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR, resolve(agentRepo, "data/runtime-vault"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenMontage dev environment rejects weak shared secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-openmontage-dev-weak-"));
  const agentRepo = join(root, "agentspace.dofe.ai");
  const montageRepo = join(root, "OpenMontage");
  mkdirSync(agentRepo);
  mkdirSync(montageRepo);
  writeFileSync(join(montageRepo, ".env"), [
    "OPENMONTAGE_SERVICE_TOKEN=short",
    `OPENMONTAGE_EVENT_SIGNING_SECRET=${"e".repeat(32)}`,
    "",
  ].join("\n"));

  try {
    assert.throws(
      () => loadOpenMontageDevEnvironment({ repoDir: agentRepo, baseEnvironment: {} }),
      /OPENMONTAGE_SERVICE_TOKEN must be configured/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenMontage dev environment preserves AgentSpace configuration with shell precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-openmontage-dev-agent-env-"));
  const agentRepo = join(root, "agentspace.dofe.ai");
  const montageRepo = join(root, "OpenMontage");
  mkdirSync(agentRepo);
  mkdirSync(montageRepo);
  writeFileSync(join(agentRepo, ".env"), [
    "DOFE_AGENT_RUNTIME_MODE=remote",
    "SELF_HOSTED_DATABASE_URL=postgresql://example.invalid/agentspace",
    "DOFE_AGENT_SERVER_URL=http://from-agent-env.invalid",
    "",
  ].join("\n"));
  writeFileSync(join(montageRepo, ".env"), [
    `OPENMONTAGE_SERVICE_TOKEN=${"s".repeat(32)}`,
    `OPENMONTAGE_EVENT_SIGNING_SECRET=${"e".repeat(32)}`,
    "",
  ].join("\n"));

  try {
    const environment = loadOpenMontageDevEnvironment({
      repoDir: agentRepo,
      baseEnvironment: {
        DOFE_AGENT_SERVER_URL: "http://from-shell.invalid",
      },
    });
    assert.equal(environment.DOFE_AGENT_RUNTIME_MODE, "remote");
    assert.equal(
      environment.SELF_HOSTED_DATABASE_URL,
      "postgresql://example.invalid/agentspace",
    );
    assert.equal(environment.DOFE_AGENT_SERVER_URL, "http://from-shell.invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
