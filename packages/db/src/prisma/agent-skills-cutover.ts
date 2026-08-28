// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 agent-skills-prisma-cutover.ts。
//
// agent-skill read cutover runner：把 sync `listStoredAgentSkillAssignmentsSync`
// 与 async primary `listAgentSkillAssignmentsAsync` 接到通用 cutover-runner。

import { listStoredAgentSkillAssignmentsSync } from "../skills.ts";
import type { StoredAgentSkillRecord } from "../types.ts";
import {
  isAgentSkillsAsyncReadEnabled,
  isAgentSkillsShadowReadEnabled,
  listAgentSkillAssignmentsAsync,
} from "./agent-skills-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListAgentSkillsCutoverMetric = ReadCutoverMetric;
export type ListAgentSkillsCutoverMetricSink = (
  metric: ListAgentSkillsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listAgentSkillAssignmentsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listAgentSkillAssignmentsCutover(
  workspaceId: string = "default",
  metricSink?: ListAgentSkillsCutoverMetricSink,
): Promise<StoredAgentSkillRecord[]> {
  return buildDomainCutover<
    string,
    StoredAgentSkillRecord[],
    ListAgentSkillsCutoverMetric
  >({
    isEnabled: isAgentSkillsAsyncReadEnabled,
    isShadowEnabled: isAgentSkillsShadowReadEnabled,
    runPrimary: async (id) => listAgentSkillAssignmentsAsync(id),
    runFallback: (id) => listStoredAgentSkillAssignmentsSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
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