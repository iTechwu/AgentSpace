import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProviderCredentialProfile, resolveProviderCredentialProfile } from "./provider-credentials.ts";
import { createManagedCredentialResolver } from "./managed-provider-credentials.ts";

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

test("managed credentials are atomically refreshed when their credential generation changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-managed-credentials-"));
  const bundles = [
    {
      version: 1 as const,
      credentialId: "credential-first",
      environment: { OPENAI_API_KEY: "first-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/v1" },
      files: {},
    },
    {
      version: 1 as const,
      credentialId: "credential-second",
      environment: { OPENAI_API_KEY: "second-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/v1" },
      files: {},
    },
  ];
  let fetches = 0;
  const resolver = createManagedCredentialResolver(root, async () => bundles[fetches++]!);

  try {
    const first = await resolver.resolve("runtime-1", "credential-first");
    const stableProfilePath = first?.profileDir;
    const stableLauncherPath = resolver.getExecutablePath("runtime-1", "codex");
    const second = await resolver.resolve("runtime-1", "credential-second");

    assert.equal(first?.environment.OPENAI_API_KEY, "first-key");
    assert.equal(second?.environment.OPENAI_API_KEY, "second-key");
    assert.equal(second?.profileDir, stableProfilePath);
    assert.equal(lstatSync(second!.profileDir).isSymbolicLink(), true);
    assert.equal(existsSync(stableLauncherPath), true);
    assert.match(readFileSync(stableLauncherPath, "utf8"), /managed-runtimes\/runtime-1\/current/);
    assert.equal(fetches, 2);
  } finally {
    resolver.cleanup("runtime-1");
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed credential launchers run the provider inside its dedicated image", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-managed-launcher-"));
  const resolver = createManagedCredentialResolver(root, async () => ({
    version: 1,
    credentialId: "credential-codex",
    environment: { OPENAI_API_KEY: "runtime-only-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/v1" },
    files: {},
  }));

  try {
    await resolver.resolve("runtime-codex", "credential-codex");
    const launcherPath = resolver.getExecutablePath("runtime-codex", "codex");
    const launcher = readFileSync(launcherPath, "utf8");

    assert.match(launcher, /docker run --rm --init/);
    assert.match(launcher, /--name 'dofe-runtime-runtime-codex'/);
    assert.match(launcher, /dofe\/agent-runtime-codex:latest/);
    assert.match(launcher, /--env OPENAI_API_KEY/);
    assert.match(launcher, /--env OPENAI_BASE_URL/);
    assert.doesNotMatch(launcher, /runtime-only-key/);
  } finally {
    resolver.cleanup("runtime-codex");
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}
