// workspace-skill read cutover runner（真 Prisma Client primary）：
// Phase 2 第十八域生产路径。pg 原型同款 runner 见 workspace-skills-cutover.ts
// （@deprecated）。

import { listStoredWorkspaceSkillsSync } from "../skills.ts";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import { listStoredWorkspaceSkillsPrisma } from "./workspace-skills-prisma.ts";

export type ListStoredWorkspaceSkillsPrismaCutoverMetric = ReadCutoverMetric;
export type ListStoredWorkspaceSkillsPrismaCutoverMetricSink = (
  metric: ListStoredWorkspaceSkillsPrismaCutoverMetric,
) => void;

const listStoredWorkspaceSkillsPrismaCutoverImpl = buildDomainCutover<
  string,
  WorkspaceSkill[],
  ListStoredWorkspaceSkillsPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (workspaceId) => listStoredWorkspaceSkillsPrisma(workspaceId),
  runFallback: (workspaceId) => listStoredWorkspaceSkillsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workspace_skill",
    operation: "list",
  }),
});

export function listStoredWorkspaceSkillsPrismaCutover(
  workspaceId: string = "default",
  metricSink?: ListStoredWorkspaceSkillsPrismaCutoverMetricSink,
): Promise<WorkspaceSkill[]> {
  return listStoredWorkspaceSkillsPrismaCutoverImpl(workspaceId, metricSink);
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