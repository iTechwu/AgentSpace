import {
  createRuntimeAppOperationSync,
  listRuntimeAppOperationsSync,
  readAgentRuntimeSync,
  readEmployeeRuntimeBindingSync,
  readRuntimeInstalledAppSync,
} from "@dofe-agent/db";
import type { RuntimeAppInstallPlan } from "@dofe-agent/domain";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { readWorkspaceSkillSync } from "./skills.ts";
import { readSkillDependencyDeclarations, type SkillDependencyDeclaration } from "./dependencies.ts";

const DEPENDENCY_SOURCE = "skill_dependency" as const;

export function queueSkillDependenciesForAgentSync(input: {
  workspaceId: string;
  employeeName: string;
  skillIds: string[];
  actorUserId: string;
  actorDisplayName: string;
}): { queued: number; skipped: number; waitingForRuntime: boolean } {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    throw new Error("Only workspace owners and admins can approve skill dependency installation.");
  }
  const runtimeBinding = readEmployeeRuntimeBindingSync(input.employeeName, input.workspaceId);
  if (!runtimeBinding) {
    return { queued: 0, skipped: 0, waitingForRuntime: true };
  }
  const runtime = readAgentRuntimeSync(runtimeBinding.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    return { queued: 0, skipped: 0, waitingForRuntime: true };
  }

  let queued = 0;
  let skipped = 0;
  for (const skillId of new Set(input.skillIds)) {
    const skill = readWorkspaceSkillSync(skillId, input.workspaceId);
    if (!skill) {
      continue;
    }
    for (const dependency of readSkillDependencyDeclarations(skill.configJson)) {
      const appName = dependencyOperationName(skill.id, dependency);
      const installed = readRuntimeInstalledAppSync({
        workspaceId: input.workspaceId,
        runtimeId: runtime.id,
        source: DEPENDENCY_SOURCE,
        name: appName,
      });
      if (installed?.status === "installed" && installed.enabled) {
        skipped += 1;
        continue;
      }
      const active = listRuntimeAppOperationsSync({
        workspaceId: input.workspaceId,
        runtimeId: runtime.id,
        limit: 500,
      }).some((operation) =>
        operation.appSource === DEPENDENCY_SOURCE
        && operation.appName === appName
        && (operation.status === "pending" || operation.status === "claimed" || operation.status === "running"),
      );
      if (active) {
        skipped += 1;
        continue;
      }

      createRuntimeAppOperationSync({
        workspaceId: input.workspaceId,
        runtimeId: runtime.id,
        appSource: DEPENDENCY_SOURCE,
        appName,
        operation: "install",
        requestedByUserId: input.actorUserId,
        commandPlanJson: JSON.stringify(buildSkillDependencyInstallPlan(skill.id, dependency)),
      });
      queued += 1;
    }
  }

  if (queued > 0) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Skill dependency installation approved",
      note: `${input.actorDisplayName} approved ${queued} declared skill dependenc${queued === 1 ? "y" : "ies"} for ${input.employeeName}.`,
      code: "workspace.skill_dependency_install_approved",
      data: {
        actorType: "session_user",
        actorUserId: input.actorUserId,
        resourceType: "skill_dependency",
        resourceId: input.employeeName,
        runtimeId: runtime.id,
      },
    });
  }
  return { queued, skipped, waitingForRuntime: false };
}

export function hasSkillDependenciesSync(input: { workspaceId: string; skillIds: string[] }): boolean {
  return input.skillIds.some((skillId) => {
    const skill = readWorkspaceSkillSync(skillId, input.workspaceId);
    return Boolean(skill && readSkillDependencyDeclarations(skill.configJson).length > 0);
  });
}

/** @deprecated Use the source-agnostic queueSkillDependenciesForAgentSync. */
export const queueGitHubSkillDependenciesForAgentSync = queueSkillDependenciesForAgentSync;
/** @deprecated Use the source-agnostic hasSkillDependenciesSync. */
export const hasGitHubSkillDependenciesSync = hasSkillDependenciesSync;

export type SkillDependencyInstallStatus =
  | "none"
  | "waiting_runtime"
  | "ok"
  | "installing"
  | "pending"
  | "failed";

/**
 * Computes the aggregate dependency-install status for one skill on one employee
 * (spec §5.3 "环境就绪 / 依赖安装失败"). Skills without declared dependencies
 * report `none`. Worst-status-wins across dependencies.
 */
export function readSkillDependencyInstallStatusSync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
}): SkillDependencyInstallStatus {
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) {
    return "none";
  }
  const dependencies = readSkillDependencyDeclarations(skill.configJson);
  if (dependencies.length === 0) {
    return "none";
  }
  const runtimeBinding = readEmployeeRuntimeBindingSync(input.employeeName, input.workspaceId);
  if (!runtimeBinding) {
    return "waiting_runtime";
  }
  const runtime = readAgentRuntimeSync(runtimeBinding.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    return "waiting_runtime";
  }

  const operations = listRuntimeAppOperationsSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    limit: 500,
  });
  let hasFailed = false;
  let hasInstalling = false;
  let hasPending = false;
  for (const dependency of dependencies) {
    const appName = dependencyOperationName(skill.id, dependency);
    const installed = readRuntimeInstalledAppSync({
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      source: DEPENDENCY_SOURCE,
      name: appName,
    });
    if (installed?.status === "installed" && installed.enabled) {
      continue;
    }
    if (installed?.status === "failed") {
      hasFailed = true;
      continue;
    }
    if (installed?.status === "installing") {
      hasInstalling = true;
      continue;
    }
    const active = operations.some((operation) => (
      operation.appSource === DEPENDENCY_SOURCE
      && operation.appName === appName
      && (operation.status === "pending" || operation.status === "claimed" || operation.status === "running")
    ));
    if (active) {
      hasInstalling = true;
    } else {
      hasPending = true;
    }
  }
  if (hasFailed) return "failed";
  if (hasInstalling) return "installing";
  if (hasPending) return "pending";
  return "ok";
}

export function buildSkillDependencyInstallPlan(
  skillId: string,
  dependency: SkillDependencyDeclaration,
): RuntimeAppInstallPlan {
  const packageReference = dependency.manager === "npm"
    ? `${dependency.name}@${dependency.version}`
    : `${dependency.name}==${dependency.version}`;
  // Isolated install into a RELATIVE per-manager deps dir under the runtime's
  // app-deps root (resolved to an absolute cwd by the daemon executor). Never
  // --global/--user (02-架构设计.md §4.1: 不能写 Provider HOME/全局 package path).
  const depsDir = dependency.manager === "npm" ? "deps/npm" : "deps/pip";
  const commands = dependency.manager === "npm"
    ? [{
      executable: "npm",
      args: ["install", "--prefix", depsDir, "--ignore-scripts", "--no-audit", "--no-fund", "--registry", DEFAULT_NPM_REGISTRY, packageReference],
      env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    }]
    : dependency.manager === "pip"
      ? [{
        executable: "python",
        args: ["-m", "pip", "install", "--target", depsDir, "--no-deps", "--no-input", "--disable-pip-version-check", "--only-binary", ":all:", "--index-url", DEFAULT_PYPI_INDEX_URL, packageReference],
      }]
      : [{
        executable: "uv",
        args: ["pip", "install", "--target", depsDir, "--no-deps", "--index-url", DEFAULT_PYPI_INDEX_URL, packageReference],
      }];
  const verifyCommands = dependency.manager === "npm"
    ? [{ executable: "npm", args: ["ls", "--prefix", depsDir, packageReference] }]
    : dependency.manager === "pip"
      ? [{ executable: "python", args: ["-m", "pip", "show", "--path", depsDir, dependency.name] }]
      : [{ executable: "uv", args: ["pip", "show", "--path", depsDir, dependency.name] }];

  return {
    app: {
      source: DEPENDENCY_SOURCE,
      name: dependencyOperationName(skillId, dependency),
      version: dependency.version,
      entryPoint: "",
    },
    strategy: dependency.manager,
    commands,
    verifyCommands,
    risk: "medium",
    requiresApproval: true,
    depsDir,
    // The reproducibility lock: the manifest's declared integrity hash, when
    // present. `resolveDependencyIntegrityLock` can populate it from the registry
    // for skills that do not declare it.
    integrityLock: dependency.integrity?.trim() || undefined,
    notes: [
      `Declared by skill ${skillId}.`,
      `Exact ${dependency.manager} dependency: ${packageReference}.`,
      "The plan uses fixed argument arrays and does not execute repository scripts.",
      "Dependencies install into the runtime's isolated deps root (never --global/--user).",
      `Registry is allow-listed (${dependency.manager === "npm" ? DEFAULT_NPM_REGISTRY : DEFAULT_PYPI_INDEX_URL}).`,
      dependency.manager === "npm"
        ? "npm lifecycle scripts are disabled."
        : "Python source distributions are not allowed for pip installs.",
    ],
  };
}

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_PYPI_INDEX_URL = "https://pypi.org/simple";

/**
 * Resolves the registry integrity lock for an exact dependency version
 * (npm `dist.integrity` / PyPI file `sha256`) — the reproducibility lock the
 * daemon records after install. Best-effort: returns null on any network or
 * metadata failure so a lock is an enrichment, never a hard blocker.
 */
export async function resolveDependencyIntegrityLock(
  dependency: SkillDependencyDeclaration,
): Promise<string | null> {
  try {
    if (dependency.manager === "npm") {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) {
        return null;
      }
      const metadata = await response.json() as { dist?: { integrity?: unknown } };
      return typeof metadata.dist?.integrity === "string" && metadata.dist.integrity.trim()
        ? metadata.dist.integrity.trim()
        : null;
    }
    const response = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}/json`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      return null;
    }
    const metadata = await response.json() as { urls?: Array<{ packagetype?: unknown; digests?: { sha256?: unknown } }> };
    const urls = Array.isArray(metadata.urls) ? metadata.urls : [];
    const wheel = urls.find((url) => url.packagetype === "bdist_wheel") ?? urls[0];
    return typeof wheel?.digests?.sha256 === "string" && wheel.digests.sha256.trim()
      ? `sha256:${wheel.digests.sha256.trim()}`
      : null;
  } catch {
    return null;
  }
}

function dependencyOperationName(skillId: string, dependency: SkillDependencyDeclaration): string {
  return `skill:${skillId}:${dependency.manager}:${dependency.name}@${dependency.version}`;
}
