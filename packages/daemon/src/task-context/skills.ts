// 3.5-4：自 task-context.ts 拆出——Agent skill 集合解析、任务期就绪门禁与
// skill 环境变量合并。
import { listStoredAgentSkillAssignmentsSync, readStoredSkillActiveArtifactDigestSync } from "@dofe-agent/db";
import type { DaemonProvider, RuntimeAppContextEntry, TaskSkillExecutionSnapshot } from "@dofe-agent/domain";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { assertSkillInstallationReadyForTaskSync, BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME, BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME, BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME, readAgentSkillRequirementEnvSync, readAgentSkillRequirementSummarySync } from "@dofe-agent/services/skills";
import { listEmployeeSkillIdsSync } from "@dofe-agent/services/employees";
import { readWorkspaceStateSync, sameValue } from "@dofe-agent/services/workspace";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";

export function resolveAgentSkills(
  workspaceState: ReturnType<typeof readWorkspaceStateSync>,
  agentProfile: ActiveEmployee | undefined,
  workspaceId?: string,
): WorkspaceSkill[] {
  if (!agentProfile) {
    return [];
  }

  const assignmentSkillIds = listEmployeeSkillIdsSync(agentProfile.name, workspaceId);
  const assignedSkills = workspaceState.skills.filter((skill: WorkspaceSkill) => assignmentSkillIds.includes(skill.id));
  const builtinOutputSkill = workspaceState.skills.find((skill) => sameValue(skill.name, BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME));
  if (builtinOutputSkill && !assignedSkills.some((skill: WorkspaceSkill) => skill.id === builtinOutputSkill.id)) {
    assignedSkills.unshift(builtinOutputSkill);
  }
  const builtinWorkspaceContextSkill = workspaceState.skills.find((skill) => sameValue(skill.name, BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME));
  if (builtinWorkspaceContextSkill && !assignedSkills.some((skill: WorkspaceSkill) => skill.id === builtinWorkspaceContextSkill.id)) {
    assignedSkills.unshift(builtinWorkspaceContextSkill);
  }
  const builtinChannelDocumentsSkill = workspaceState.skills.find((skill) => sameValue(skill.name, BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME));
  if (builtinChannelDocumentsSkill && !assignedSkills.some((skill: WorkspaceSkill) => skill.id === builtinChannelDocumentsSkill.id)) {
    assignedSkills.unshift(builtinChannelDocumentsSkill);
  }

  return assignedSkills;
}

/**
 * Re-validates per-employee Skill configuration at task time. A Skill that was
 * bound but whose required config/secret/model/provider is incomplete would
 * otherwise run with a silently incomplete environment; this surfaces the
 * precise blocker so the task fails fast with an actionable message instead.
 * Runtime-offline (`awaiting_validation`) is intentionally NOT a task-time
 * failure here — the runtime executing this task is by definition the one being
 * validated.
 */
export function collectSkillReadinessBlockers(
  workspaceId: string,
  agentName: string | undefined,
  agentSkills: WorkspaceSkill[],
  runtimeId: string,
  runtimeProvider: DaemonProvider | undefined,
  /**
   * Optional set of capability ids the runtime actually exposes (tool commands /
   * app names). When supplied, a skill `capability:X` that the runtime does not
   * expose is reported as a blocker (spec §6.4). Omit to preserve the legacy
   * form-confirmation behavior until a capability convention is agreed.
   */
  availableCapabilityIds?: readonly string[],
  /**
   * The task's frozen Skill execution snapshot. When present it is the source of
   * truth for the installation check: each assigned skill must be pinned in the
   * snapshot AND that pinned installation must still be `ready` (freshness
   * fail-closed — a rollback that degraded the pinned revision blocks the task).
   * Omit to preserve the legacy per-skill digest-resolution behavior.
   */
  snapshot?: TaskSkillExecutionSnapshot,
): string[] {
  if (!agentName || agentSkills.length === 0) {
    return [];
  }
  const blockers: string[] = [];
  const snapshotEntryBySkillId = new Map<string, TaskSkillExecutionSnapshot["entries"][number]>(
    (snapshot?.entries ?? []).map((entry) => [entry.skillId, entry]),
  );
  for (const skill of agentSkills) {
    if (skill.sourceType === "builtin" || skill.sourceType === "clihub_runtime_app") {
      continue;
    }
    const summary = readAgentSkillRequirementSummarySync({
      workspaceId,
      employeeName: agentName,
      skillId: skill.id,
      runtimeProvider,
      runtimeCapabilities: availableCapabilityIds,
    });
    for (const blocker of summary.blockers) {
      blockers.push(`"${skill.name}": ${blocker}`);
    }

    if (snapshot) {
      blockers.push(...collectSnapshotInstallationBlockers({
        skill,
        workspaceId,
        runtimeId,
        entry: snapshotEntryBySkillId.get(skill.id),
      }));
      continue;
    }

    const assignments = listStoredAgentSkillAssignmentsSync(workspaceId)
      .filter((assignment) => assignment.employeeName === agentName);
    const digestBySkillId = new Map<string, string | undefined>(
      assignments.map((assignment) => [assignment.skillId, assignment.skillArtifactDigest]),
    );
    const pinnedDigest = digestBySkillId.get(skill.id);
    const artifactDigest = pinnedDigest ?? readStoredSkillActiveArtifactDigestSync(skill.id, workspaceId) ?? undefined;
    if (!artifactDigest) {
      blockers.push(`"${skill.name}": has no active artifact digest; install or reassign the skill before running tasks.`);
      continue;
    }
    const gate = assertSkillInstallationReadyForTaskSync({ workspaceId, runtimeId, artifactDigest });
    if (!gate.ok) {
      blockers.push(`"${skill.name}": ${gate.reason}`);
    }
  }
  return blockers;
}

/**
 * Snapshot-based installation gate: the skill must be pinned in the task's
 * snapshot AND its pinned installation must still be the currently-ready one
 * (same installationId) — a rollback that degraded or re-resolved the pinned
 * revision fails closed.
 */
function collectSnapshotInstallationBlockers(input: {
  skill: WorkspaceSkill;
  workspaceId: string;
  runtimeId: string;
  entry: TaskSkillExecutionSnapshot["entries"][number] | undefined;
}): string[] {
  const { skill, workspaceId, runtimeId, entry } = input;
  if (!entry) {
    return [`"${skill.name}": has no ready skill installation on this runtime; install the skill before running tasks.`];
  }
  const gate = assertSkillInstallationReadyForTaskSync({ workspaceId, runtimeId, artifactDigest: entry.artifactDigest });
  if (!gate.ok) {
    return [`"${skill.name}": ${gate.reason}`];
  }
  if (gate.installationId !== entry.installationId) {
    return [
      `"${skill.name}": the pinned installation revision (${entry.revision}) is no longer the active ready installation; ` +
        "re-install or re-assign the skill before retrying.",
    ];
  }
  return [];
}

export function buildRuntimeCapabilityIds(runtimeApps: RuntimeAppContextEntry[]): string[] {
  return [
    "dofe-agent-output",
    ...runtimeApps
      .filter((app) => app.entryPoint?.trim())
      .map((app) => `clihub:${app.source}:${app.name}`),
  ];
}

export function resolveAgentSkillEnvironment(
  workspaceId: string | undefined,
  agentName: string | undefined,
  agentSkills: WorkspaceSkill[],
): { env: Record<string, string>; conflicts: string[] } {
  const env: Record<string, string> = {};
  const conflicts: string[] = [];
  if (!agentName) {
    return { env, conflicts };
  }

  for (const skill of agentSkills) {
    const skillEnv = readAgentSkillRequirementEnvSync({
      workspaceId,
      employeeName: agentName,
      skillId: skill.id,
    });
    for (const [key, value] of Object.entries(skillEnv)) {
      if (key.startsWith("DOFE_AGENT_")) {
        continue;
      }
      if (env[key] === undefined) {
        env[key] = value;
      } else if (env[key] !== value) {
        conflicts.push(key);
      }
    }
  }

  return { env, conflicts };
}

export function filterRuntimeAppSkillsByRuntimeAvailability(
  skills: WorkspaceSkill[],
  runtimeApps: RuntimeAppContextEntry[],
): WorkspaceSkill[] {
  const availableAppKeys = new Set(runtimeApps.map((app) => `${app.source}:${app.name}`));
  return skills.filter((skill) => {
    if (skill.sourceType !== "clihub_runtime_app") {
      return true;
    }
    const requiredAppKey = readRuntimeAppSkillConfigKey(skill.configJson);
    return Boolean(requiredAppKey && availableAppKeys.has(requiredAppKey));
  });
}

function readRuntimeAppSkillConfigKey(configJson: string | undefined): string | undefined {
  if (!configJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(configJson) as {
      runtimeApp?: {
        source?: unknown;
        name?: unknown;
      };
    };
    if (typeof parsed.runtimeApp?.source === "string" && typeof parsed.runtimeApp.name === "string") {
      return `${parsed.runtimeApp.source}:${parsed.runtimeApp.name}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
