import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SkillDependencyDeclaration } from "@dofe-agent/services";
import type { ExecResult } from "@dofe-agent/sandbox";
import { resetSkillDependencyEnvironment } from "./task-environment.ts";

/**
 * Real dependency install + verification (02-架构设计.md §4.1): dependencies are
 * installed into an isolated per-installation envs directory (never
 * --global/--user / Provider HOME), using planner-generated commands with exact
 * versions and an allow-listed registry, followed by an independent verify step.
 */

export interface DependencyRegistries {
  npm: string;
  pip: string;
  uv: string;
}

export const DEFAULT_DEPENDENCY_REGISTRIES: DependencyRegistries = {
  npm: "https://registry.npmjs.org",
  pip: "https://pypi.org/simple",
  uv: "https://pypi.org/simple",
};

export const NPM_REGISTRY_ENV = "DOFE_AGENT_NPM_REGISTRY";
export const PYPI_INDEX_URL_ENV = "DOFE_AGENT_PYPI_INDEX_URL";

export interface DependencyInstallResult {
  ok: boolean;
  reason?: string;
}

export interface SandboxLike {
  exec(command: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Platform-configured allow-list. Manifest-supplied registries are NEVER trusted. */
export function resolveDependencyRegistries(env: NodeJS.ProcessEnv = process.env): DependencyRegistries {
  return {
    npm: env[NPM_REGISTRY_ENV]?.trim() || DEFAULT_DEPENDENCY_REGISTRIES.npm,
    pip: env[PYPI_INDEX_URL_ENV]?.trim() || DEFAULT_DEPENDENCY_REGISTRIES.pip,
    uv: env[PYPI_INDEX_URL_ENV]?.trim() || DEFAULT_DEPENDENCY_REGISTRIES.uv,
  };
}

/** Pure command planner — generates the install command for one dependency. */
export function buildDependencyInstallCommand(
  dep: SkillDependencyDeclaration,
  envsDir: string,
  registries: DependencyRegistries,
): { command: string; args: string[] } {
  switch (dep.manager) {
    case "npm":
      return {
        command: "npm",
        args: [
          "install",
          "--prefix",
          envsDir,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry",
          registries.npm,
          `${dep.name}@${dep.version}`,
        ],
      };
    case "pip":
      return {
        command: "python",
        args: [
          "-m",
          "pip",
          "install",
          "--target",
          envsDir,
          "--no-deps",
          "--no-input",
          "--disable-pip-version-check",
          "--only-binary",
          ":all:",
          "--index-url",
          registries.pip,
          `${dep.name}==${dep.version}`,
        ],
      };
    case "uv":
      return {
        command: "uv",
        args: [
          "pip",
          "install",
          "--target",
          envsDir,
          "--no-deps",
          "--index-url",
          registries.uv,
          `${dep.name}==${dep.version}`,
        ],
      };
    case "system":
      // System packages come from the immutable runner image; the daemon only
      // verifies the cataloged binary is present (fail-closed if absent).
      return { command: "sh", args: ["-c", `command -v ${dep.name} || exit 1`] };
  }
}

/** Installs dependencies into the envs dir and independently verifies each one. */
export async function installSkillDependenciesSync(input: {
  dependencies: SkillDependencyDeclaration[];
  envsDir: string;
  sandbox: SandboxLike;
  registries?: DependencyRegistries;
  env?: NodeJS.ProcessEnv;
}): Promise<Map<string, DependencyInstallResult>> {
  const registries = input.registries ?? resolveDependencyRegistries(input.env);
  const results = new Map<string, DependencyInstallResult>();

  if (input.dependencies.length === 0) {
    return results;
  }

  // Wipe + rebuild so no stale version survives a re-install.
  resetSkillDependencyEnvironment(input.envsDir);
  rmSync(input.envsDir, { recursive: true, force: true });
  mkdirSync(input.envsDir, { recursive: true });

  const execEnv = buildInstallEnv(input.envsDir, input.env);
  for (const dep of input.dependencies) {
    const key = `${dep.manager}:${dep.name}@${dep.version}`;
    const plan = buildDependencyInstallCommand(dep, input.envsDir, registries);
    try {
      const execResult = await input.sandbox.exec({
        command: plan.command,
        args: plan.args,
        cwd: input.envsDir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: execEnv,
      });
      if (execResult.exitCode !== 0 || execResult.timedOut) {
        results.set(key, {
          ok: false,
          reason: `install exited with ${execResult.exitCode ?? (execResult.timedOut ? "timeout" : "signal")}`,
        });
        continue;
      }
      const verified = await verifyInstalledDependency(dep, input.envsDir, input.sandbox);
      results.set(key, verified ? { ok: true } : { ok: false, reason: "verify failed: package/version not found in envs dir" });
    } catch (error) {
      results.set(key, {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * Independent verification WITHOUT trusting the install command: checks the
 * installed artifact directly in the envs dir (package.json version for npm,
 * dist-info directory for pip/uv).
 */
async function verifyInstalledDependency(
  dep: SkillDependencyDeclaration,
  envsDir: string,
  sandbox: SandboxLike,
): Promise<boolean> {
  if (dep.manager === "npm") {
    try {
      const pkgJson = JSON.parse(await sandbox.readFile(join(envsDir, "node_modules", dep.name, "package.json"))) as {
        version?: string;
      };
      return pkgJson.version === dep.version;
    } catch {
      return false;
    }
  }
  // pip/uv both lay down `<name>_<version>.dist-info` (pip normalizes `-` to `_`).
  const normalizedName = dep.name.replace(/-/g, "_");
  const expected = `${normalizedName}-${dep.version}.dist-info`;
  try {
    const entries = await sandbox.readDir(envsDir);
    return entries.some((entry) => entry.isDirectory && entry.name.toLowerCase() === expected.toLowerCase());
  } catch {
    return false;
  }
}

/** Minimal env for package installs: only PATH + HOME/CACHE inside the envs dir — no secrets. */
export function buildInstallEnv(envsDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "",
    HOME: envsDir,
    NPM_CONFIG_CACHE: join(envsDir, ".npm-cache"),
    PIP_CACHE_DIR: join(envsDir, ".pip-cache"),
  };
}
