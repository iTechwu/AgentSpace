import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProviderCredentialProfile, resolveProviderCredentialProfile } from "./provider-credentials.ts";

test("resolves account-scoped provider files and environment without exposing references", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  const credentialRoot = join(root, "credentials");
  const stateDir = join(root, "state");
  try {
    const configPath = join(credentialRoot, "team-a.config.json");
    const secretPath = join(credentialRoot, "team-a.secret.json");
    writeJson(configPath, {
      version: 1,
      environment: { ANTHROPIC_BASE_URL: "https://gateway.team-a.example" },
      files: { ".config/openclaw/models.json": "{\"models\":[]}" },
    });
    writeJson(secretPath, {
      version: 1,
      environment: { ANTHROPIC_API_KEY: "team-a-key" },
      files: { ".claude.json": "{\"oauthAccount\":{}}" },
    });
    const mapPath = join(credentialRoot, "provider-accounts.json");
    writeJson(mapPath, { accounts: { "provider-account-team-a": { configRef: `file://${configPath}`, secretRef: `file://${secretPath}` } } });

    const profile = resolveProviderCredentialProfile({
      stateDir,
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: credentialRoot,
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: `file://${mapPath}`,
      },
    });

    assert.ok(profile);
    assert.equal(profile.environment.ANTHROPIC_BASE_URL, "https://gateway.team-a.example");
    assert.equal(profile.environment.ANTHROPIC_API_KEY, "team-a-key");
    assert.equal(readFileSync(join(profile.profileDir, ".claude.json"), "utf8"), "{\"oauthAccount\":{}}");
    assert.equal(existsSync(join(profile.profileDir, ".config/openclaw/models.json")), true);

    const targetEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "host-key",
    };
    applyProviderCredentialProfile(profile, targetEnv);
    assert.equal(targetEnv.HOME, profile.profileDir);
    assert.equal(targetEnv.ANTHROPIC_API_KEY, "team-a-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects credential symlinks which resolve outside the runtime credential root", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  try {
    const credentialRoot = join(root, "credentials");
    const outsidePath = join(root, "outside.json");
    writeJson(outsidePath, { environment: { ANTHROPIC_API_KEY: "not-for-this-runtime" } });
    mkdirSync(credentialRoot, { recursive: true });
    const linkedPath = join(credentialRoot, "linked.json");
    symlinkSync(outsidePath, linkedPath);

    assert.throws(() => resolveProviderCredentialProfile({
      stateDir: join(root, "state"),
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: credentialRoot,
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: `file://${linkedPath}`,
      },
    }), /must stay within/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects credential references outside the runtime credential root", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  try {
    assert.throws(() => resolveProviderCredentialProfile({
      stateDir: join(root, "state"),
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: join(root, "credentials"),
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: "file:///etc/passwd",
      },
    }), /must stay within/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}
