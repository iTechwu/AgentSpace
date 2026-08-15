// workspace-memberships read cutover runner（真 Prisma Client primary）：
// 与 audit-log / notifications / task-execution-events 同款双 runner 模式。

import { listWorkspaceMembershipsSync } from "../workspace-memberships.ts";
import type { StoredWorkspaceMembershipRecord } from "../types.ts";
import {
  isWorkspaceMembershipsPrismaReadEnabled,
  isWorkspaceMembershipsPrismaShadowReadEnabled,
  listWorkspaceMembershipsPrisma,
} from "./workspace-memberships-prisma.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkspaceMembershipsPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkspaceMembershipsPrismaCutoverMetricSink = (
  metric: ListWorkspaceMembershipsPrismaCutoverMetric,
) => void;

const listWorkspaceMembershipsPrismaCutoverImpl = buildDomainCutover<
  string,
  StoredWorkspaceMembershipRecord[],
  ListWorkspaceMembershipsPrismaCutoverMetric
>({
  isEnabled: isWorkspaceMembershipsPrismaReadEnabled,
  isShadowEnabled: isWorkspaceMembershipsPrismaShadowReadEnabled,
  runPrimary: async (workspaceId) => listWorkspaceMembershipsPrisma(workspaceId),
  runFallback: (workspaceId) => listWorkspaceMembershipsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

export function listWorkspaceMembershipsPrismaCutover(
  workspaceId: string,
  metricSink?: ListWorkspaceMembershipsPrismaCutoverMetricSink,
): Promise<StoredWorkspaceMembershipRecord[]> {
  return listWorkspaceMembershipsPrismaCutoverImpl(workspaceId, metricSink);
}

export function recordsEqual(
  primary: StoredWorkspaceMembershipRecord[],
  fallback: StoredWorkspaceMembershipRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredWorkspaceMembershipRecord,
  fallback: StoredWorkspaceMembershipRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.userId === fallback.userId &&
    primary.role === fallback.role &&
    primary.status === fallback.status &&
    primary.joinedAt === fallback.joinedAt &&
    primary.invitedBy === fallback.invitedBy
  );
}

const defaultMetricSink: ListWorkspaceMembershipsPrismaCutoverMetricSink = () => {};