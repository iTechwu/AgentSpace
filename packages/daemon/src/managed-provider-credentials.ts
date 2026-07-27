import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import type { DaemonProvider } from "@dofe-agent/domain";
import type { ManagedCredentialBundleDocument } from "./daemon-api.ts";
import { cleanupCredentialProfile, writeCredentialProfile, type ProviderCredentialProfile } from "./provider-credentials.ts";

export interface ManagedCredentialResolver {
  resolve(runtimeId: string, expectedCredentialId?: string): Promise<ProviderCredentialProfile | null>;
  getExecutablePath(runtimeId: string, provider: DaemonProvider): string;
  cleanup(runtimeId: string): void;
}

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCLAW_API_KEY",
  "NANOBOT_API_KEY",
  "HERMES_API_KEY",
]);

const PROVIDER_EXECUTABLES: Record<DaemonProvider, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  gemini: "gemini",
  opencode: "opencode",
  openclaw: "openclaw",
  nanobot: "nanobot",
  hermes: "hermes-agent",
};

const PROVIDER_ENVIRONMENT_KEYS: Record<DaemonProvider, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"],
  antigravity: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  gemini: ["GEMINI_API_KEY", "GEMINI_BASE_URL", "GOOGLE_API_KEY"],
  opencode: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENCODE_API_KEY"],
  openclaw: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENCLAW_API_KEY"],
  nanobot: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "NANOBOT_API_KEY"],
  hermes: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "HERMES_API_KEY"],
};

export function getManagedProviderCredentialEnvironmentKey(provider: DaemonProvider): string {
  const key = PROVIDER_ENVIRONMENT_KEYS[provider].find((candidate) => candidate.endsWith("_API_KEY"));
  if (!key) {
    throw new Error(`managed_runtime.credential_env_key_missing:${provider}`);
  }
  return key;
}

export function createManagedCredentialResolver(
  stateDir: string,
  fetchBundle: (runtimeId: string) => Promise<ManagedCredentialBundleDocument>,
): ManagedCredentialResolver {
  const cache = new Map<string, { credentialId: string; profile: ProviderCredentialProfile }>();

  async function resolve(runtimeId: string, expectedCredentialId?: string): Promise<ProviderCredentialProfile | null> {
    const cached = cache.get(runtimeId);
    if (cached && (!expectedCredentialId || cached.credentialId === expectedCredentialId)) {
      return cached.profile;
    }

    const bundle = await fetchBundle(runtimeId);
    if (bundle.version !== 1) {
      throw new Error(`managed_runtime.unsupported_credential_bundle_version:${bundle.version}`);
    }
    if (!bundle.credentialId) {
      throw new Error("managed_runtime.credential_bundle_id_missing");
    }
    if (expectedCredentialId && bundle.credentialId !== expectedCredentialId) {
      throw new Error(`managed_runtime.credential_bundle_id_mismatch:${runtimeId}`);
    }

    const profileDir = pathResolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    const filteredEnvironment: Record<string, string> = {};
    for (const [key, value] of Object.entries(bundle.environment)) {
      if (!ALLOWED_ENVIRONMENT_KEYS.has(key)) {
        throw new Error(`managed_runtime.disallowed_credential_env_key:${key}`);
      }
      filteredEnvironment[key] = value;
    }
    const document = {
      version: 1,
      environment: filteredEnvironment,
      files: bundle.files,
    };
    const profile = writeCredentialProfile(profileDir, document);
    const managedProfile: ProviderCredentialProfile = {
      accountId: runtimeId,
      profileDir: profile.profileDir,
      environment: profile.environment,
    };
    cache.set(runtimeId, { credentialId: bundle.credentialId, profile: managedProfile });
    return managedProfile;
  }

  function cleanup(runtimeId: string): void {
    cache.delete(runtimeId);
    const profileDir = pathResolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    cleanupCredentialProfile(profileDir);
  }

  function getExecutablePath(runtimeId: string, provider: DaemonProvider): string {
    const profileDir = pathResolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    const launcherPath = join(profileDir, "run-provider");
    writeFileSync(launcherPath, buildDockerProviderLauncher(profileDir, runtimeId, provider), {
      encoding: "utf8",
      mode: 0o700,
    });
    chmodSync(launcherPath, 0o700);
    return launcherPath;
  }

  return { resolve, getExecutablePath, cleanup };
}

function buildDockerProviderLauncher(profileDir: string, runtimeId: string, provider: DaemonProvider): string {
  const imageTag = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest";
  const image = `dofe/agent-runtime-${provider}:${imageTag}`;
  const environmentArgs = PROVIDER_ENVIRONMENT_KEYS[provider]
    .map((key) => `  --env ${key} \\\n`)
    .join("");
  return [
    "#!/bin/sh",
    "set -eu",
    "exec docker run --rm --init \\",
    `  --name ${shellQuote(`dofe-runtime-${normalizeRuntimeId(runtimeId)}`)} \\`,
    "  --mount \\\"type=bind,src=$(pwd),dst=/workspace\\\" \\",
    `  --mount ${shellQuote(`type=bind,src=${profileDir},dst=/dofe-profile`)} \\`,
    "  --workdir /workspace \\",
    "  --env HOME=/dofe-profile \\",
    environmentArgs.trimEnd(),
    `  ${shellQuote(image)} ${shellQuote(PROVIDER_EXECUTABLES[provider])} \"$@\"`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeRuntimeId(value: string): string {
  // Runtime ids include prefixes like "runtime-managed-..." and may contain
  // characters that are safe for filesystem names but not for arbitrary nesting.
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
