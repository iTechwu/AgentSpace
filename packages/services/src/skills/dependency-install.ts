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

export function queueGitHubSkillDependenciesForAgentSync(input: {
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
    if (!skill || skill.sourceType !== "github") {
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
      note: `${input.actorDisplayName} approved ${queued} declared GitHub skill dependenc${queued === 1 ? "y" : "ies"} for ${input.employeeName}.`,
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

export function hasGitHubSkillDependenciesSync(input: { workspaceId: string; skillIds: string[] }): boolean {
  return input.skillIds.some((skillId) => {
    const skill = readWorkspaceSkillSync(skillId, input.workspaceId);
    return skill?.sourceType === "github" && readSkillDependencyDeclarations(skill.configJson).length > 0;
  });
}

export function buildSkillDependencyInstallPlan(
  skillId: string,
  dependency: SkillDependencyDeclaration,
): RuntimeAppInstallPlan {
  const packageReference = dependency.manager === "npm"
    ? `${dependency.name}@${dependency.version}`
    : `${dependency.name}==${dependency.version}`;
  const commands = dependency.manager === "npm"
    ? [{
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", packageReference],
      env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    }]
    : dependency.manager === "pip"
      ? [{
        executable: "python",
        args: ["-m", "pip", "install", "--user", "--no-input", "--disable-pip-version-check", "--only-binary", ":all:", packageReference],
      }]
      : [{
        executable: "uv",
        args: ["tool", "install", "--no-cache", packageReference],
      }];
  const verifyCommands = dependency.manager === "npm"
    ? [{ executable: "npm", args: ["list", "--global", "--depth=0", dependency.name] }]
    : dependency.manager === "pip"
      ? [{ executable: "python", args: ["-m", "pip", "show", dependency.name] }]
      : [{ executable: "uv", args: ["tool", "list"] }];

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
    notes: [
      `Declared by GitHub skill ${skillId}.`,
      `Exact ${dependency.manager} dependency: ${packageReference}.`,
      "The plan uses fixed argument arrays and does not execute repository scripts.",
      dependency.manager === "npm"
        ? "npm lifecycle scripts are disabled."
        : "Python source distributions are not allowed for pip installs.",
    ],
  };
}

function dependencyOperationName(skillId: string, dependency: SkillDependencyDeclaration): string {
  return `skill:${skillId}:${dependency.manager}:${dependency.name}@${dependency.version}`;
}
