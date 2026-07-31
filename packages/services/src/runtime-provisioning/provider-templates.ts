import type { DaemonProvider } from "@dofe-agent/domain";
import type { AgentRuntimeRecord } from "@dofe-agent/db";
import { resolveModelsGatewayBaseUrl } from "../config/deployment.ts";

export interface ManagedProvisioningCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ManagedProvisioningCommandContext {
  runtimeId: string;
  runtimeCredentialId: string;
  gatewayBaseUrl: string;
  imageTag: string;
}

const ALLOWED_COMMAND_EXECUTABLES = new Set([
  "docker",
  "sh",
  "bash",
  "rm",
  "mkdir",
  "chmod",
  "curl",
  "command",
]);

const PROVIDER_CREDENTIAL_ENV_KEYS: Record<DaemonProvider, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  antigravity: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  opencode: "OPENAI_API_KEY",
  openclaw: "OPENAI_API_KEY",
  nanobot: "OPENAI_API_KEY",
  hermes: "OPENAI_API_KEY",
};

const PROVIDER_EXECUTABLES: Record<DaemonProvider, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  gemini: "gemini",
  opencode: "opencode",
  openclaw: "openclaw",
  nanobot: "nanobot",
  hermes: "/opt/hermes/.venv/bin/hermes-agent",
};

export function getManagedRuntimeCredentialEnvKey(provider: DaemonProvider): string {
  const key = PROVIDER_CREDENTIAL_ENV_KEYS[provider];
  if (!key) {
    throw new Error(`managed_runtime.no_credential_env_key:${provider}`);
  }
  return key;
}

/**
 * The set of env keys that a managed runtime injects for SOME provider. A Skill
 * that declares one of these risks colliding with (or shadowing) the runtime
 * credential when that provider is bound later — used for the unbound-runtime /
 * config-time warning (spec §0 "未绑定 Runtime 时的未来凭据冲突").
 */
export function getManagedRuntimeCredentialEnvKeys(): string[] {
  return Array.from(new Set(Object.values(PROVIDER_CREDENTIAL_ENV_KEYS))).sort();
}

const PROVIDER_GATEWAY_BASE_URLS: Record<DaemonProvider, string> = {
  claude: "{{gatewayBaseUrl}}/anthropic",
  codex: "{{gatewayBaseUrl}}/v1",
  antigravity: "{{gatewayBaseUrl}}/v1",
  gemini: "{{gatewayBaseUrl}}/gemini",
  opencode: "{{gatewayBaseUrl}}/v1",
  openclaw: "{{gatewayBaseUrl}}/v1",
  nanobot: "{{gatewayBaseUrl}}/v1",
  hermes: "{{gatewayBaseUrl}}/v1",
};

export interface ManagedRuntimeProviderTemplate {
  runtimeType: DaemonProvider;
  credentialEnvKey: string;
  pullImageCommands: ManagedProvisioningCommand[];
  installCliCommands: ManagedProvisioningCommand[];
  healthCheckCommands: ManagedProvisioningCommand[];
  cleanupCommands: ManagedProvisioningCommand[];
}

export function resolveManagedRuntimeGatewayBaseUrl(): string {
  return resolveModelsGatewayBaseUrl();
}

export function buildManagedProvisioningCommandContext(
  runtime: AgentRuntimeRecord,
): ManagedProvisioningCommandContext {
  if (!runtime.managedCredentialId) {
    throw new Error("managed_runtime.credential_id_missing");
  }
  return {
    runtimeId: runtime.id,
    runtimeCredentialId: runtime.managedCredentialId,
    gatewayBaseUrl: resolveManagedRuntimeGatewayBaseUrl(),
    imageTag: process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() ?? "latest",
  };
}

export function buildManagedProvisioningStageCommands(
  runtimeType: DaemonProvider,
  stage: "pull_image" | "install_cli" | "health_check" | "cleanup",
  context: ManagedProvisioningCommandContext,
): ManagedProvisioningCommand[] {
  const template = MANAGED_RUNTIME_TEMPLATES[runtimeType];
  if (!template) {
    throw new Error(`managed_runtime.no_template_for_provider:${runtimeType}`);
  }
  const raw =
    stage === "pull_image"
      ? template.pullImageCommands
      : stage === "install_cli"
        ? template.installCliCommands
        : stage === "health_check"
          ? template.healthCheckCommands
          : template.cleanupCommands;
  return raw.map((cmd) => ({
    executable: cmd.executable,
    args: cmd.args.map((arg) => substitutePlaceholders(arg, context)),
    env: cmd.env
      ? Object.fromEntries(
          Object.entries(cmd.env).map(([k, v]) => [k, substitutePlaceholders(v, context)]),
        )
      : undefined,
  }));
}

export interface ManagedCredentialBundleDocument {
  version: 1;
  credentialId: string;
  environment: Record<string, string>;
  files: Record<string, string>;
}

export function buildManagedCredentialBundleDocument(
  runtime: AgentRuntimeRecord,
  plaintextApiKey: string,
): ManagedCredentialBundleDocument {
  const runtimeType = runtime.provider;
  const envKey = PROVIDER_CREDENTIAL_ENV_KEYS[runtimeType];
  if (!envKey) {
    throw new Error(`managed_runtime.no_credential_env_key:${runtimeType}`);
  }
  const gatewayBaseUrl = resolveProtocolGatewayBaseUrl(runtimeType, resolveManagedRuntimeGatewayBaseUrl());
  return {
    version: 1,
    credentialId: runtime.managedCredentialId ?? "",
    environment: {
      [envKey]: plaintextApiKey,
      [getGatewayBaseUrlEnvironmentKey(runtimeType, envKey)]: gatewayBaseUrl,
    },
    files: {},
  };
}

function getGatewayBaseUrlEnvironmentKey(provider: DaemonProvider, credentialEnvKey: string): string {
  if (provider === "gemini") {
    return "GEMINI_BASE_URL";
  }
  return credentialEnvKey.replace(/_API_KEY$/, "_BASE_URL");
}

function resolveProtocolGatewayBaseUrl(provider: DaemonProvider, gatewayBaseUrl: string): string {
  const template = PROVIDER_GATEWAY_BASE_URLS[provider];
  if (provider !== "gemini") {
    return template.replace("{{gatewayBaseUrl}}", gatewayBaseUrl.replace(/\/$/, ""));
  }
  // Gemini requires https and lives at {gatewayBase}/gemini, preserving the
  // deployment path prefix (e.g. /api) the same way the OpenAI/Anthropic
  // templates preserve it via {{gatewayBaseUrl}} substitution.
  const url = new URL(gatewayBaseUrl);
  url.protocol = "https:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/gemini`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function substitutePlaceholders(value: string, context: ManagedProvisioningCommandContext): string {
  return value
    .replace(/\{\{runtimeId\}\}/g, context.runtimeId)
    .replace(/\{\{runtimeCredentialId\}\}/g, context.runtimeCredentialId)
    .replace(/\{\{gatewayBaseUrl\}\}/g, context.gatewayBaseUrl)
    .replace(/\{\{imageTag\}\}/g, context.imageTag);
}

function cmd(executable: string, ...args: string[]): ManagedProvisioningCommand {
  if (!ALLOWED_COMMAND_EXECUTABLES.has(executable)) {
    throw new Error(`managed_runtime.disallowed_executable:${executable}`);
  }
  return { executable, args };
}

export const MANAGED_RUNTIME_TEMPLATES: Record<DaemonProvider, ManagedRuntimeProviderTemplate> = {
  claude: buildDockerTemplate("claude", "claude"),
  codex: buildDockerTemplate("codex", "codex"),
  antigravity: buildDockerTemplate("antigravity", "antigravity"),
  gemini: buildDockerTemplate("gemini", "gemini"),
  opencode: buildDockerTemplate("opencode", "opencode"),
  openclaw: buildDockerTemplate("openclaw", "openclaw"),
  nanobot: buildDockerTemplate("nanobot", "nanobot"),
  hermes: buildDockerTemplate("hermes", "hermes"),
};

function buildDockerTemplate(
  provider: DaemonProvider,
  imageName: string,
): ManagedRuntimeProviderTemplate {
  return {
    runtimeType: provider,
    credentialEnvKey: PROVIDER_CREDENTIAL_ENV_KEYS[provider],
    pullImageCommands: [
      cmd(
        "sh",
        "-c",
        `docker image inspect 'dofe/agent-runtime-${imageName}:{{imageTag}}' >/dev/null 2>&1 || { echo >&2 "Approved managed runtime image dofe/agent-runtime-${imageName}:{{imageTag}} is unavailable locally. Build the approved image on this managed node before retrying."; exit 42; }`,
      ),
    ],
    installCliCommands: [
      cmd(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        `dofe/agent-runtime-${imageName}:{{imageTag}}`,
        "-c",
        `command -v ${PROVIDER_EXECUTABLES[provider]}`,
      ),
    ],
    // The node executes the authenticated /v1/models probe in memory so the
    // Runtime Key never appears in a command line or container inspection.
    healthCheckCommands: [
      cmd("docker", "image", "inspect", `dofe/agent-runtime-${imageName}:{{imageTag}}`),
    ],
    cleanupCommands: [
      cmd(
        "sh",
        "-c",
        "docker rm -f dofe-runtime-{{runtimeId}} 2>/dev/null || true",
      ),
      cmd(
        "sh",
        "-c",
        "docker volume rm dofe-runtime-vol-{{runtimeId}} 2>/dev/null || true",
      ),
      cmd("rm", "-rf", "{{managedProfileDir}}/{{runtimeId}}"),
    ],
  };
}

export function buildManagedCleanupCommands(
  runtimeType: DaemonProvider,
  runtimeId: string,
): ManagedProvisioningCommand[] {
  const context: ManagedProvisioningCommandContext = {
    runtimeId: normalizeManagedRuntimePathSegment(runtimeId),
    runtimeCredentialId: "cleanup",
    gatewayBaseUrl: resolveManagedRuntimeGatewayBaseUrl(),
    imageTag: process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() ?? "latest",
  };
  return buildManagedProvisioningStageCommands(runtimeType, "cleanup", context);
}

function normalizeManagedRuntimePathSegment(runtimeId: string): string {
  return runtimeId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
