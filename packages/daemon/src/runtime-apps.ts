import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { RuntimeAppCommandPlanItem, RuntimeAppInstallPlan } from "@dofe-agent/domain";

const MAX_TAIL_CHARS = 8_000;
const SECRET_PATTERNS = [
  /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"',;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

export interface RuntimeAppReadinessItem {
  available: boolean;
  version?: string;
  error?: string;
}

export interface CliHubReadiness {
  checkedAt: string;
  python: RuntimeAppReadinessItem;
  pip: RuntimeAppReadinessItem;
  cliHub: RuntimeAppReadinessItem;
  npm: RuntimeAppReadinessItem;
  uv: RuntimeAppReadinessItem;
}

export interface RuntimeAppExecutionResult {
  safeStdoutTail: string;
  safeStderrTail: string;
}

export async function executeRuntimeAppPlan(plan: RuntimeAppInstallPlan): Promise<RuntimeAppExecutionResult> {
  let stdout = "";
  let stderr = "";
  for (const command of [...plan.commands, ...plan.verifyCommands]) {
    const result = await execCommand(command);
    stdout += `\n$ ${renderCommand(command)}\n${result.stdout}`;
    stderr += result.stderr ? `\n$ ${renderCommand(command)}\n${result.stderr}` : "";
  }
  return {
    safeStdoutTail: tailAndRedact(stdout),
    safeStderrTail: tailAndRedact(stderr),
  };
}

export function readCliHubReadiness(): CliHubReadiness {
  return {
    checkedAt: new Date().toISOString(),
    python: checkCommand("python", ["--version"]),
    pip: checkCommand("python", ["-m", "pip", "--version"]),
    cliHub: checkCommand("cli-hub", ["--version"]),
    npm: checkCommand("npm", ["--version"]),
    uv: checkCommand("uv", ["--version"]),
  };
}

export function parseRuntimeAppInstallPlan(value: unknown): RuntimeAppInstallPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as RuntimeAppInstallPlan;
  if (
    !plan.app ||
    typeof plan.app.name !== "string" ||
    !Array.isArray(plan.commands) ||
    !Array.isArray(plan.verifyCommands)
  ) {
    return null;
  }
  if (![...plan.commands, ...plan.verifyCommands].every(isCommandPlanItem)) {
    return null;
  }
  return plan;
}

function checkCommand(command: string, args: string[]): RuntimeAppReadinessItem {
  const result = spawnSync(command, args, {
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) {
    return { available: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      available: false,
      error: tailAndRedact(`${result.stderr || result.stdout || `${command} exited with code ${result.status}`}`),
    };
  }
  const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0]?.trim();
  return {
    available: true,
    version: version || undefined,
  };
}

function execCommand(command: RuntimeAppCommandPlanItem): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: {
        ...process.env,
        ...(command.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      stdout = stdout.slice(-MAX_TAIL_CHARS * 2);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      stderr = stderr.slice(-MAX_TAIL_CHARS * 2);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${renderCommand(command)} exited with code ${code}. ${tailAndRedact(stderr || stdout)}`);
      reject(Object.assign(error, {
        stdout: tailAndRedact(stdout),
        stderr: tailAndRedact(stderr),
      }));
    });
  });
}

function isCommandPlanItem(value: unknown): value is RuntimeAppCommandPlanItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as RuntimeAppCommandPlanItem;
  return (
    typeof record.executable === "string" &&
    record.executable.trim().length > 0 &&
    Array.isArray(record.args) &&
    record.args.every((arg) => typeof arg === "string")
  );
}

function renderCommand(command: RuntimeAppCommandPlanItem): string {
  return [command.executable, ...command.args].join(" ");
}

export function tailAndRedact(value: string): string {
  let output = value.slice(-MAX_TAIL_CHARS);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string, separator?: string) =>
      separator ? `${prefix}${separator}[REDACTED]` : `${prefix}[REDACTED]`,
    );
  }
  return output;
}
