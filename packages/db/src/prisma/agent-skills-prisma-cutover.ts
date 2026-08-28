// agent-skill read cutover runner（真 Prisma Client primary）：
// Phase 2 第七域生产路径。pg 原型同款 runner 见 agent-skills-cutover.ts（@deprecated）。

import { listStoredAgentSkillAssignmentsSync } from "../skills.ts";
import type { StoredAgentSkillRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isAgentSkillsPrismaReadEnabled,
  isAgentSkillsPrismaShadowReadEnabled,
  listAgentSkillAssignmentsPrisma,
} from "./agent-skills-prisma.ts";

export type ListAgentSkillsPrismaCutoverMetric = ReadCutoverMetric;
export type ListAgentSkillsPrismaCutoverMetricSink = (
  metric: ListAgentSkillsPrismaCutoverMetric,
) => void;

const listAgentSkillAssignmentsPrismaCutoverImpl = buildDomainCutover<
  string,
  StoredAgentSkillRecord[],
  ListAgentSkillsPrismaCutoverMetric
>({
  isEnabled: isAgentSkillsPrismaReadEnabled,
  isShadowEnabled: isAgentSkillsPrismaShadowReadEnabled,
  runPrimary: async (workspaceId) => listAgentSkillAssignmentsPrisma(workspaceId),
  runFallback: (workspaceId) => listStoredAgentSkillAssignmentsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({ domain: "agent_skills", operation: "list" }),
});

export function listAgentSkillAssignmentsPrismaCutover(
  workspaceId: string = "default",
  metricSink?: ListAgentSkillsPrismaCutoverMetricSink,
): Promise<StoredAgentSkillRecord[]> {
  return listAgentSkillAssignmentsPrismaCutoverImpl(workspaceId, metricSink);
}

export function recordsEqual(
  primary: StoredAgentSkillRecord[],
  fallback: StoredAgentSkillRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredAgentSkillRecord,
  fallback: StoredAgentSkillRecord,
): boolean {
  return (
    primary.workspaceId === fallback.workspaceId &&
    primary.agentId === fallback.agentId &&
    primary.employeeId === fallback.employeeId &&
    primary.employeeName === fallback.employeeName &&
    primary.skillId === fallback.skillId &&
    primary.skillArtifactDigest === fallback.skillArtifactDigest &&
    primary.rolloutPin === fallback.rolloutPin &&
    primary.createdAt === fallback.createdAt
  );
}
