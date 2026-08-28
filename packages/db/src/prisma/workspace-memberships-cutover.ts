// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workspace-memberships-prisma-cutover.ts。
//
// workspace-memberships read cutover runner：把 sync `listWorkspaceMembershipsSync`
// 与 async primary `listWorkspaceMembershipsAsync` 接到通用 cutover-runner，
// 落地 Phase 2 协议（与 audit-log / notifications / task-execution-events 同款）：
// - Flag OFF  → 直接走 sync fallback（与 cut 1 前一致，零额外开销）
// - Flag ON   → 走 async primary；shadow ON 时同时跑 sync fallback 并 compare

import { listWorkspaceMembershipsSync } from "../workspace-memberships.ts";
import type { StoredWorkspaceMembershipRecord } from "../types.ts";
import {
  isWorkspaceMembershipsAsyncReadEnabled,
  isWorkspaceMembershipsShadowReadEnabled,
  listWorkspaceMembershipsAsync,
} from "./workspace-memberships-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkspaceMembershipsCutoverMetric = ReadCutoverMetric;
export type ListWorkspaceMembershipsCutoverMetricSink = (
  metric: ListWorkspaceMembershipsCutoverMetric,
) => void;

const listWorkspaceMembershipsCutoverImpl = buildDomainCutover<
  string,
  StoredWorkspaceMembershipRecord[],
  ListWorkspaceMembershipsCutoverMetric
>({
  isEnabled: isWorkspaceMembershipsAsyncReadEnabled,
  isShadowEnabled: isWorkspaceMembershipsShadowReadEnabled,
  runPrimary: async (workspaceId) => listWorkspaceMembershipsAsync(workspaceId),
  runFallback: (workspaceId) => listWorkspaceMembershipsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

/**
 * @deprecated Use {@link listWorkspaceMembershipsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkspaceMembershipsCutover(
  workspaceId: string,
  metricSink?: ListWorkspaceMembershipsCutoverMetricSink,
): Promise<StoredWorkspaceMembershipRecord[]> {
  return listWorkspaceMembershipsCutoverImpl(workspaceId, metricSink);
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

const defaultMetricSink: ListWorkspaceMembershipsCutoverMetricSink = () => {
  // Default no-op sink: callers can pass their own for telemetry. Tests inject
  // an array-pushing sink to inspect emitted metrics.
};