import { spawnSync } from "node:child_process";

const GOOGLE_WORKSPACE_EXECUTOR_ENV = "DOFE_AGENT_GOOGLE_WORKSPACE_EXECUTOR";

export interface GoogleWorkspaceReadiness {
  checkedAt: string;
  executor: string;
  dofeAgentOutput: CommandReadiness;
  gws: CommandReadiness;
  bwrap: CommandReadiness & {
    supportsPerms?: boolean;
  };
}

export interface CommandReadiness {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export function readGoogleWorkspaceReadiness(environment: NodeJS.ProcessEnv = process.env): GoogleWorkspaceReadiness {
  const executor = environment[GOOGLE_WORKSPACE_EXECUTOR_ENV]?.trim() || "gws";
  return {
    checkedAt: new Date().toISOString(),
    executor,
    dofeAgentOutput: checkDofeAgentOutput(environment),
    gws: checkCommandVersion(executor, ["--version"], environment),
    bwrap: checkBwrap(environment),
  };
}

function checkDofeAgentOutput(environment: NodeJS.ProcessEnv): CommandReadiness {
  const command = "dofe-agent";
  const available = checkCommandVersion(command, ["output", "--help"], environment);
  if (!available.available) {
    return available;
  }
  for (const args of [
    ["output", "sheets-result", "add", "--help"],
    ["output", "validate", "--help"],
  ]) {
    const result = run(command, args, environment);
    if (result.status !== 0) {
      return {
        ...available,
        available: false,
        error: sanitizeOutput(result.stderr || result.stdout || `${command} ${args.join(" ")} failed.`),
      };
    }
  }
  return available;
}

function checkBwrap(environment: NodeJS.ProcessEnv): GoogleWorkspaceReadiness["bwrap"] {
  const version = checkCommandVersion("bwrap", ["--version"], environment);
  if (!version.available) {
    return version;
  }
  const help = run("bwrap", ["--help"], environment);
  const output = `${help.stdout}\n${help.stderr}`;
  const supportsPerms = output.includes("--perms");
  return {
    ...version,
    available: supportsPerms,
    supportsPerms,
    error: supportsPerms
      ? version.error
      : "bubblewrap is installed but does not support --perms; Codex-based agents may fail unless Codex can fall back to its vendored bwrap.",
  };
}

function checkCommandVersion(command: string, args: string[], environment: NodeJS.ProcessEnv): CommandReadiness {
  const result = run(command, args, environment);
  if (result.error) {
    return {
      available: false,
      error: result.error,
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      error: sanitizeOutput(result.stderr || result.stdout || `${command} ${args.join(" ")} failed.`),
    };
  }
  return {
    available: true,
    version: sanitizeOutput(result.stdout || result.stderr),
  };
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
} {
  const result = spawnSync(command, args, {
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: `${command} was not found on PATH.`,
      };
    }
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error.message,
    };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sanitizeOutput(value: string): string {
  return value.trim().replace(/[\r\n]+/g, " ").slice(0, 500);
}
