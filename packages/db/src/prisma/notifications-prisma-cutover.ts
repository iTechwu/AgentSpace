// notifications read cutover runner（真 Prisma Client primary）：与 audit-log
// 同款双 runner 模式，pg 原型切流 flag = NOTIFICATIONS_ASYNC_*，Prisma 真接入
// flag = NOTIFICATIONS_PRISMA_*，互不干扰。

import { listWorkspaceNotificationsForRecipientSync } from "../notifications.ts";
import type { ListWorkspaceNotificationsOptions } from "../notifications.ts";
import type { WorkspaceNotificationRecord } from "../types.ts";
import {
  isNotificationsPrismaReadEnabled,
  isNotificationsPrismaShadowReadEnabled,
  listWorkspaceNotificationsPrisma,
} from "./notifications-prisma.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListNotificationsPrismaCutoverMetric = ReadCutoverMetric;
export type ListNotificationsPrismaCutoverMetricSink = (
  metric: ListNotificationsPrismaCutoverMetric,
) => void;

const listWorkspaceNotificationsPrismaCutoverImpl = buildDomainCutover<
  ListWorkspaceNotificationsOptions,
  WorkspaceNotificationRecord[],
  ListNotificationsPrismaCutoverMetric
>({
  isEnabled: isNotificationsPrismaReadEnabled,
  isShadowEnabled: isNotificationsPrismaShadowReadEnabled,
  runPrimary: async (options) => listWorkspaceNotificationsPrisma(options),
  runFallback: (options) => listWorkspaceNotificationsForRecipientSync(options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({ domain: "notifications", operation: "list" }),
});

export function listWorkspaceNotificationsPrismaCutover(
  options: ListWorkspaceNotificationsOptions,
  metricSink?: ListNotificationsPrismaCutoverMetricSink,
): Promise<WorkspaceNotificationRecord[]> {
  return listWorkspaceNotificationsPrismaCutoverImpl(options, metricSink);
}

export function recordsEqual(
  primary: WorkspaceNotificationRecord[],
  fallback: WorkspaceNotificationRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkspaceNotificationRecord,
  fallback: WorkspaceNotificationRecord,
): boolean {
  const metadataEqual = JSON.stringify(primary.metadataJson ?? {}) ===
    JSON.stringify(fallback.metadataJson ?? {});
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.recipientType === fallback.recipientType &&
    primary.recipientId === fallback.recipientId &&
    primary.actorType === fallback.actorType &&
    primary.actorId === fallback.actorId &&
    primary.type === fallback.type &&
    primary.resourceType === fallback.resourceType &&
    primary.resourceId === fallback.resourceId &&
    primary.channelName === fallback.channelName &&
    primary.title === fallback.title &&
    primary.body === fallback.body &&
    primary.actionHref === fallback.actionHref &&
    primary.severity === fallback.severity &&
    primary.status === fallback.status &&
    primary.dedupeKey === fallback.dedupeKey &&
    metadataEqual &&
    primary.createdAt === fallback.createdAt &&
    primary.readAt === fallback.readAt &&
    primary.archivedAt === fallback.archivedAt
  );
}
