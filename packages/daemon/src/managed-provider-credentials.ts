import { resolve as pathResolve } from "node:path";
import type { ManagedCredentialBundleDocument } from "./daemon-api.ts";
import { cleanupCredentialProfile, writeCredentialProfile, type ProviderCredentialProfile } from "./provider-credentials.ts";

export interface ManagedCredentialResolver {
  resolve(runtimeId: string): Promise<ProviderCredentialProfile | null>;
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
  "GOOGLE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCLAW_API_KEY",
  "NANOBOT_API_KEY",
  "HERMES_API_KEY",
]);

export function createManagedCredentialResolver(
  stateDir: string,
  fetchBundle: (runtimeId: string) => Promise<ManagedCredentialBundleDocument>,
): ManagedCredentialResolver {
  const cache = new Map<string, ProviderCredentialProfile>();

  async function resolve(runtimeId: string): Promise<ProviderCredentialProfile | null> {
    const cached = cache.get(runtimeId);
    if (cached) return cached;

    const bundle = await fetchBundle(runtimeId);
    if (bundle.version !== 1) {
      throw new Error(`managed_runtime.unsupported_credential_bundle_version:${bundle.version}`);
    }

    const profileDir = resolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
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
    cache.set(runtimeId, managedProfile);
    return managedProfile;
  }

  function cleanup(runtimeId: string): void {
    cache.delete(runtimeId);
    const profileDir = resolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    cleanupCredentialProfile(profileDir);
  }

  return { resolve, cleanup };
}

function normalizeRuntimeId(value: string): string {
  // Runtime ids include prefixes like "runtime-managed-..." and may contain
  // characters that are safe for filesystem names but not for arbitrary nesting.
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
