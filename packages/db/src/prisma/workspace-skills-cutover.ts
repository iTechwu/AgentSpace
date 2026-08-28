// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workspace-skills-prisma-cutover.ts。

import { listStoredWorkspaceSkillsSync } from "../skills.ts";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import {
  isWorkspaceSkillsAsyncReadEnabled,
  isWorkspaceSkillsShadowReadEnabled,
  listStoredWorkspaceSkillsAsync,
} from "./workspace-skills-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkspaceSkillsCutoverMetric = ReadCutoverMetric;
export type ListWorkspaceSkillsCutoverMetricSink = (
  metric: ListWorkspaceSkillsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listStoredWorkspaceSkillsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listStoredWorkspaceSkillsCutover(
  workspaceId: string = "default",
  metricSink?: ListWorkspaceSkillsCutoverMetricSink,
): Promise<WorkspaceSkill[]> {
  return buildDomainCutover<
    string,
    WorkspaceSkill[],
    ListWorkspaceSkillsCutoverMetric
  >({
    isEnabled: isWorkspaceSkillsAsyncReadEnabled,
    isShadowEnabled: isWorkspaceSkillsShadowReadEnabled,
    runPrimary: async (id) => listStoredWorkspaceSkillsAsync(id),
    runFallback: (id) => listStoredWorkspaceSkillsSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
}

export function recordsEqual(
  primary: WorkspaceSkill[],
  fallback: WorkspaceSkill[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkspaceSkill,
  fallback: WorkspaceSkill,
): boolean {
  if (primary.id !== fallback.id) return false;
  if (primary.name !== fallback.name) return false;
  if (primary.description !== fallback.description) return false;
  if (primary.sourceType !== fallback.sourceType) return false;
  if (primary.sourceUrl !== fallback.sourceUrl) return false;
  if (primary.configJson !== fallback.configJson) return false;
  if (primary.createdAt !== fallback.createdAt) return false;
  if (primary.updatedAt !== fallback.updatedAt) return false;
  if (primary.files.length !== fallback.files.length) return false;
  for (let i = 0; i < primary.files.length; i += 1) {
    const p = primary.files[i]!;
    const f = fallback.files[i]!;
    if (
      p.id !== f.id ||
      p.path !== f.path ||
      p.content !== f.content ||
      p.createdAt !== f.createdAt ||
      p.updatedAt !== f.updatedAt
    ) {
      return false;
    }
  }
  return true;
}