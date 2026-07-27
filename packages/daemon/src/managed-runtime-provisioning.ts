import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type {
  ManagedProvisioningCommand,
  ManagedProvisioningStage,
  ManagedProvisioningTask,
} from "./daemon-api.ts";
import type { ManagedCredentialResolver } from "./managed-provider-credentials.ts";
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
        await credentialResolver.resolve(task.runtimeId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          errorCode: "managed_runtime.write_credential_failed",
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
    credentialResolver.cleanup(runtimeId);
    return result;
  }

  return { execute, executeCleanup };
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
