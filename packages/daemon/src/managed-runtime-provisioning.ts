import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveProviderProtocols } from "@dofe-agent/domain";
import type {
  ManagedProvisioningCommand,
  ManagedProvisioningStage,
  ManagedProvisioningTask,
} from "./daemon-api.ts";
import {
  buildManagedRuntimeDockerConnectivityArgs,
  getManagedProviderCredentialEnvironmentKey,
  resolveManagedRuntimeDockerNetwork,
  type ManagedCredentialResolver,
} from "./managed-provider-credentials.ts";
import type { ProviderCredentialProfile } from "./provider-credentials.ts";
import { buildRedactions, redactText } from "./agent-router/utils.ts";

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

const STAGE_TIMEOUT_MS: Record<ManagedProvisioningStage, number> = {
  pull_image: 10 * 60 * 1000,
  install_cli: 5 * 60 * 1000,
  write_credential: 30 * 1000,
  health_check: 30 * 1000,
  cleanup: 2 * 60 * 1000,
};

export interface ManagedProvisioningResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
}

export interface ManagedProvisioningExecutor {
  execute(task: ManagedProvisioningTask): Promise<ManagedProvisioningResult>;
  credentialResolver: ManagedCredentialResolver;
  executeCleanup(
    runtimeId: string,
    commands: ManagedProvisioningCommand[],
  ): Promise<ManagedProvisioningResult>;
}

export function createManagedProvisioningExecutor(
  stateDir: string,
  credentialResolver: ManagedCredentialResolver,
): ManagedProvisioningExecutor {
  const managedProfileDir = resolve(stateDir, "managed-runtimes");

  async function execute(task: ManagedProvisioningTask): Promise<ManagedProvisioningResult> {
    if (task.stage === "write_credential") {
      try {
        await credentialResolver.resolve(task.runtimeId, task.runtimeCredentialId);
        credentialResolver.getExecutablePath(task.runtimeId, task.runtimeType);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          errorCode: "managed_runtime.write_credential_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (task.stage === "health_check") {
      try {
        const profile = await credentialResolver.resolve(task.runtimeId, task.runtimeCredentialId);
        if (!profile) {
          throw new Error("managed_runtime.credential_profile_missing");
        }
        const probeResult = await runCommandSequence(task.runtimeId, task.stage, [
          buildManagedContainerHealthCheckCommand(profile, task.runtimeType),
          buildManagedAttributionProxyHealthCheckCommand(
            profile,
            credentialResolver.getExecutablePath(task.runtimeId, task.runtimeType),
            {
              runtimeId: task.runtimeId,
              runtimeCredentialId: task.runtimeCredentialId,
              provider: task.runtimeType,
            },
          ),
          buildManagedProviderLauncherHealthCheckCommand(
            profile,
            credentialResolver.getExecutablePath(task.runtimeId, task.runtimeType),
          ),
        ]);
        if (!probeResult.success) {
          throw new Error(probeResult.errorMessage ?? "managed_runtime.container_gateway_health_failed");
        }
      } catch (error) {
        return {
          success: false,
          errorCode: "managed_runtime.gateway_health_check_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const commands = substituteManagedProfileDir(task.commands, managedProfileDir);
    return runCommandSequence(task.runtimeId, task.stage, commands);
  }

  async function executeCleanup(
    runtimeId: string,
    commands: ManagedProvisioningCommand[],
  ): Promise<ManagedProvisioningResult> {
    const substituted = substituteManagedProfileDir(commands, managedProfileDir);
    const result = await runCommandSequence(runtimeId, "cleanup", substituted);
    if (result.success) {
      credentialResolver.cleanup(runtimeId);
    }
    return result;
  }

  return { execute, executeCleanup, credentialResolver };
}

export async function probeManagedGateway(
  profile: ProviderCredentialProfile,
  provider: ManagedProvisioningTask["runtimeType"],
  request: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }> =
    async (url, init) => fetch(url, init),
): Promise<void> {
  const credentialKey = getManagedProviderCredentialEnvironmentKey(provider);
  const apiKey = profile.environment[credentialKey];
  const baseUrl = Object.entries(profile.environment)
    .find(([key]) => key.endsWith("_BASE_URL"))?.[1];
  if (!apiKey || !baseUrl) {
    throw new Error("managed_runtime.gateway_health_credentials_missing");
  }
  const endpoint = resolveManagedGatewayHealthEndpoint(baseUrl, provider);
  const response = await request(endpoint, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(provider === "claude" ? { "x-api-key": apiKey } : {}),
      ...(provider === "gemini" ? { "x-goog-api-key": apiKey } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`managed_runtime.gateway_health_http_${response.status}`);
  }
}

export function buildManagedContainerHealthCheckCommand(
  profile: ProviderCredentialProfile,
  provider: ManagedProvisioningTask["runtimeType"],
): ManagedProvisioningCommand {
  const baseUrl = Object.entries(profile.environment)
    .find(([key]) => key.endsWith("_BASE_URL"))?.[1];
  if (!baseUrl) throw new Error("managed_runtime.gateway_health_credentials_missing");
  const endpoint = resolveManagedGatewayHealthEndpoint(baseUrl, provider);
  const imageTag = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest";
  const user = `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`;
  const script = [
    'const { readFileSync } = require("node:fs");',
    'const key = readFileSync("/dofe-profile/runtime-key", "utf8").trim();',
    'const endpoint = process.argv[1];',
    'const provider = process.argv[2];',
    'const headers = { authorization: `Bearer ${key}` };',
    'if (provider === "claude") headers["x-api-key"] = key;',
    'if (provider === "gemini") headers["x-goog-api-key"] = key;',
    'fetch(endpoint, { headers }).then((response) => {',
    '  if (!response.ok) throw new Error(`gateway_http_${response.status}`);',
    '}).catch((error) => { console.error(error.message); process.exit(1); });',
  ].join("\n");
  return {
    executable: "docker",
    args: [
      "run", "--rm", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      ...buildManagedRuntimeDockerConnectivityArgs(),
      "--network", resolveManagedRuntimeDockerNetwork(),
      "--user", user,
      "--mount", `type=bind,src=${profile.profileDir},dst=/dofe-profile,readonly`,
      "--entrypoint", "node",
      `dofe/agent-runtime-${provider}:${imageTag}`,
      "-e", script, endpoint, provider,
    ],
  };
}

export function buildManagedProviderLauncherHealthCheckCommand(
  profile: ProviderCredentialProfile,
  launcherPath: string,
): ManagedProvisioningCommand {
  return {
    executable: "sh",
    args: [launcherPath, "--version"],
    env: Object.fromEntries(
      Object.entries(profile.environment).filter(([key]) => key.endsWith("_BASE_URL")),
    ),
  };
}

export function buildManagedAttributionProxyHealthCheckCommand(
  profile: ProviderCredentialProfile,
  launcherPath: string,
  input: {
    runtimeId: string;
    runtimeCredentialId: string;
    provider: ManagedProvisioningTask["runtimeType"];
  },
): ManagedProvisioningCommand {
  const modelPath = resolveManagedGatewayHealthPath(input.provider);
  const providerBaseUrlKey = getManagedProviderBaseUrlEnvironmentKey(input.provider);
  const providerBaseUrl = profile.environment[providerBaseUrlKey];
  const healthBaseUrl = providerBaseUrl
    ? resolveManagedGatewayHealthBaseUrl(providerBaseUrl, input.provider)
    : undefined;
  return {
    executable: "sh",
    args: [launcherPath, "--version"],
    env: {
      ...Object.fromEntries(
        Object.entries(profile.environment)
          .filter(([key]) => key.endsWith("_BASE_URL"))
          .map(([key, value]) => [
            key,
            key === providerBaseUrlKey ? healthBaseUrl ?? value : value,
          ]),
      ),
      DOFE_AGENT_MANAGED_PROXY_HEALTHCHECK: "1",
      DOFE_AGENT_GATEWAY_HEALTHCHECK_PATH: modelPath,
      DOFE_AGENT_RUNTIME_CREDENTIAL_ID: input.runtimeCredentialId,
      DOFE_AGENT_RUNTIME_ID: input.runtimeId,
      DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID: "healthcheck",
      DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID: "healthcheck",
      DOFE_AGENT_GATEWAY_PROTOCOL: resolveProviderProtocols(input.provider)[0] ?? "",
    },
  };
}

function resolveManagedGatewayHealthEndpoint(
  baseUrl: string,
  provider: ManagedProvisioningTask["runtimeType"],
): string {
  return `${resolveManagedGatewayHealthBaseUrl(baseUrl, provider)}${resolveManagedGatewayHealthPath(provider)}`;
}

function resolveManagedGatewayHealthBaseUrl(
  baseUrl: string,
  provider: ManagedProvisioningTask["runtimeType"],
): string {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  // Claude traffic uses the Anthropic protocol prefix, while model discovery is
  // exposed by the gateway's shared OpenAI-compatible endpoint.
  return provider === "claude"
    ? normalizedBaseUrl.replace(/\/anthropic$/, "")
    : normalizedBaseUrl;
}

function getManagedProviderBaseUrlEnvironmentKey(
  provider: ManagedProvisioningTask["runtimeType"],
): string {
  return provider === "gemini"
    ? "GEMINI_BASE_URL"
    : provider === "claude"
      ? "ANTHROPIC_BASE_URL"
      : "OPENAI_BASE_URL";
}

function resolveManagedGatewayHealthPath(
  provider: ManagedProvisioningTask["runtimeType"],
): string {
  return provider === "gemini"
    ? "/v1beta/models"
    : provider === "claude"
      ? "/v1/models"
      : "/models";
}

async function runCommandSequence(
  runtimeId: string,
  stage: ManagedProvisioningStage,
  commands: ManagedProvisioningCommand[],
): Promise<ManagedProvisioningResult> {
  const timeoutMs = STAGE_TIMEOUT_MS[stage];
  let lastStdout = "";
  let lastStderr = "";

  for (const command of commands) {
    if (!ALLOWED_COMMAND_EXECUTABLES.has(command.executable)) {
      return {
        success: false,
        errorCode: "managed_runtime.disallowed_executable",
        errorMessage: `Disallowed executable: ${command.executable}`,
      };
    }

    const redactions = buildRedactions(command.env ?? {});
    const safeCommand = redactCommand(command, redactions);
    const result = await runCommand(command, timeoutMs);

    lastStdout = redactText(result.stdout, redactions);
    lastStderr = redactText(result.stderr, redactions);

    if (!result.success) {
      return {
        success: false,
        errorCode: `managed_runtime.${stage}_failed`,
        errorMessage: `Command ${safeCommand.executable} ${safeCommand.args.join(" ")} failed: ${result.errorMessage}`,
        safeStdoutTail: tail(lastStdout),
        safeStderrTail: tail(lastStderr),
      };
    }
  }

  return { success: true, safeStdoutTail: tail(lastStdout), safeStderrTail: tail(lastStderr) };
}

interface CommandRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

function runCommand(command: ManagedProvisioningCommand, timeoutMs: number): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      env: { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        stdout,
        stderr,
        errorMessage: error.message,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        resolve({
          success: false,
          stdout,
          stderr,
          errorMessage: timedOut ? "Timed out" : `Exit code ${exitCode ?? "unknown"}`,
        });
      }
    });
  });
}

function redactCommand(
  command: ManagedProvisioningCommand,
  redactions: ReturnType<typeof buildRedactions>,
): ManagedProvisioningCommand {
  return {
    executable: command.executable,
    args: command.args.map((arg) => redactText(arg, redactions)),
    env: command.env
      ? Object.fromEntries(Object.entries(command.env).map(([k, v]) => [k, redactText(v, redactions)]))
      : undefined,
  };
}

function substituteManagedProfileDir(
  commands: ManagedProvisioningCommand[],
  managedProfileDir: string,
): ManagedProvisioningCommand[] {
  return commands.map((cmd) => ({
    executable: cmd.executable,
    args: cmd.args.map((arg) => arg.replace(/\{\{managedProfileDir\}\}/g, managedProfileDir)),
    env: cmd.env
      ? Object.fromEntries(
          Object.entries(cmd.env).map(([k, v]) => [k, v.replace(/\{\{managedProfileDir\}\}/g, managedProfileDir)]),
        )
      : undefined,
  }));
}

function tail(value: string, limit = 4000): string {
  if (value.length <= limit) return value;
  return `...${value.slice(value.length - limit)}`;
}
