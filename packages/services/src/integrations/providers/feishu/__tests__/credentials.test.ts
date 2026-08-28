import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildEncryptedFeishuCredentials,
  readFeishuIntegrationCredentials,
  summarizeFeishuStoredCredentials,
} from "../credentials.ts";

test("Feishu credentials are encrypted at rest and only summarized for settings", () => {
  const originalRepositoryRoot = process.env.DOFE_AGENT_REPOSITORY_ROOT;
  const originalFeishuKey = process.env.DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY;
  const originalAgentSpaceFeishuKey = process.env.AGENT_SPACE_FEISHU_CREDENTIAL_ENCRYPTION_KEY;
  const repositoryRoot = mkdtempSync(join(tmpdir(), "dofe-agent-feishu-credentials-"));
  writeFileSync(join(repositoryRoot, "Target.md"), "test\n");

  process.env.DOFE_AGENT_REPOSITORY_ROOT = repositoryRoot;
  process.env.DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY = Buffer
    .from("0123456789abcdef0123456789abcdef", "utf8")
    .toString("base64");

  try {
    const encrypted = buildEncryptedFeishuCredentials({
      appSecret: "super-secret-app-secret",
      verificationToken: "verify-token",
      encryptKey: "encrypt-key",
    });
    const serialized = JSON.stringify(encrypted);
    const integration = {
      encryptedCredentialsJson: serialized,
    } as Parameters<typeof readFeishuIntegrationCredentials>[0];

    assert.match(encrypted.appSecret, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.match(encrypted.verificationToken, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.match(encrypted.encryptKey ?? "", /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.doesNotMatch(serialized, /super-secret-app-secret|verify-token|encrypt-key/);
    assert.deepEqual(summarizeFeishuStoredCredentials(integration), {
      hasAppSecret: true,
      hasVerificationToken: true,
      hasEncryptKey: true,
    });
    assert.deepEqual(readFeishuIntegrationCredentials(integration), {
      appSecret: "super-secret-app-secret",
      verificationToken: "verify-token",
      encryptKey: "encrypt-key",
    });
  } finally {
    restoreOptionalEnv("DOFE_AGENT_REPOSITORY_ROOT", originalRepositoryRoot);
    restoreOptionalEnv("DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY", originalFeishuKey);
    restoreOptionalEnv("AGENT_SPACE_FEISHU_CREDENTIAL_ENCRYPTION_KEY", originalAgentSpaceFeishuKey);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Feishu credentials use the AgentSpace encryption key when no legacy key is set", () => {
  const originalRepositoryRoot = process.env.DOFE_AGENT_REPOSITORY_ROOT;
  const originalFeishuKey = process.env.DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY;
  const originalIntegrationKey = process.env.DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
  const originalAgentSpaceFeishuKey = process.env.AGENT_SPACE_FEISHU_CREDENTIAL_ENCRYPTION_KEY;
  const repositoryRoot = mkdtempSync(join(tmpdir(), "dofe-agent-feishu-agent-space-key-"));
  writeFileSync(join(repositoryRoot, "Target.md"), "test\n");

  process.env.DOFE_AGENT_REPOSITORY_ROOT = repositoryRoot;
  delete process.env.DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
  process.env.AGENT_SPACE_FEISHU_CREDENTIAL_ENCRYPTION_KEY = Buffer
    .from("abcdef0123456789abcdef0123456789", "utf8")
    .toString("base64");

  try {
    const encrypted = buildEncryptedFeishuCredentials({ appSecret: "agent-space-secret" });
    const integration = {
      encryptedCredentialsJson: JSON.stringify(encrypted),
    } as Parameters<typeof readFeishuIntegrationCredentials>[0];

    assert.deepEqual(readFeishuIntegrationCredentials(integration), {
      appSecret: "agent-space-secret",
      verificationToken: "",
      encryptKey: undefined,
    });
  } finally {
    restoreOptionalEnv("DOFE_AGENT_REPOSITORY_ROOT", originalRepositoryRoot);
    restoreOptionalEnv("DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY", originalFeishuKey);
    restoreOptionalEnv("DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", originalIntegrationKey);
    restoreOptionalEnv("AGENT_SPACE_FEISHU_CREDENTIAL_ENCRYPTION_KEY", originalAgentSpaceFeishuKey);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
