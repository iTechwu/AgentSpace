// notifications read cutover runner：把 sync `listWorkspaceNotificationsForRecipientSync`
// 与 async primary `listWorkspaceNotificationsAsync` 接到通用 cutover-runner，
// 落地 Phase 2 协议（与 audit-log / task-execution-events 同款）：
// - Flag OFF  → 直接走 sync fallback（与 cut 1 前一致，零额外开销）
// - Flag ON   → 走 async primary；shadow ON 时同时跑 sync fallback 并 compare
// - 列表 compare 用结构化 JSON 比较，处理 pg JSONB / sqlite JSON.stringify
//   的格式差异
//
// createListWorkspaceNotificationsCutover 工厂把 cutover runner 抽象为可注入
// isEnabled / isShadowEnabled / runPrimary / runFallback 的闭包，便于单测
// 不依赖真实 PG 与 sync API 直接断言 primary / shadow / fallback 三分支行为。

import { listWorkspaceNotificationsForRecipientSync } from "../notifications.ts";
import type { ListWorkspaceNotificationsOptions } from "../notifications.ts";
import type { WorkspaceNotificationRecord } from "../types.ts";
import {
  isNotificationsAsyncReadEnabled,
  isNotificationsShadowReadEnabled,
  listWorkspaceNotificationsAsync,
} from "./notifications-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export interface ListNotificationsCutoverMetric extends ReadCutoverMetric {}

export type ListNotificationsCutoverMetricSink = (metric: ListNotificationsCutoverMetric) => void;

export interface ListNotificationsCutoverOptions {
  isEnabled?: () => boolean;
  isShadowEnabled?: () => boolean;
  runPrimary?: () => Promise<WorkspaceNotificationRecord[]>;
  runFallback?: () => WorkspaceNotificationRecord[];
}

const listWorkspaceNotificationsCutoverImpl = buildDomainCutover<
  ListWorkspaceNotificationsOptions,
  WorkspaceNotificationRecord[],
  ListNotificationsCutoverMetric
>({
  isEnabled: isNotificationsAsyncReadEnabled,
  isShadowEnabled: isNotificationsShadowReadEnabled,
  runPrimary: async (options) => listWorkspaceNotificationsAsync(options),
  runFallback: (options) => listWorkspaceNotificationsForRecipientSync(options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

/**
 * Async read cutover for workspace-notifications list. Returns the async
 * primary result when Phase 2 flag is on; falls back to the legacy sync
 * result on primary error.
 */
export function listWorkspaceNotificationsCutover(
  options: ListWorkspaceNotificationsOptions,
  metricSink?: ListNotificationsCutoverMetricSink,
): Promise<WorkspaceNotificationRecord[]> {
  return listWorkspaceNotificationsCutoverImpl(options, metricSink);
}

/**
 * Build a cutover runner with injected flag / runPrimary / runFallback
 * closures. Defaults wire the production async primary + sync fallback +
 * env-driven flags; tests pass custom closures to drive primary/shadow/
 * fallback branches deterministically.
 */
export function createListWorkspaceNotificationsCutover(
  overrides: ListNotificationsCutoverOptions = {},
): (options: ListWorkspaceNotificationsOptions, metricSink?: ListNotificationsCutoverMetricSink) => Promise<WorkspaceNotificationRecord[]> {
  return (options, metricSink) =>
    buildDomainCutover<ListWorkspaceNotificationsOptions, WorkspaceNotificationRecord[], ListNotificationsCutoverMetric>({
      isEnabled: overrides.isEnabled ?? isNotificationsAsyncReadEnabled,
      isShadowEnabled: overrides.isShadowEnabled ?? isNotificationsShadowReadEnabled,
      runPrimary: overrides.runPrimary ?? (async () => listWorkspaceNotificationsAsync(options)),
      runFallback: overrides.runFallback ?? (() => listWorkspaceNotificationsForRecipientSync(options)),
      compare: (primary, fallback) => recordsEqual(primary, fallback),
    })(options, metricSink);
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
  // metadata_json shape: pg JSONB parsed to object, sqlite stores raw string.
  // Compare structurally.
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

const defaultMetricSink: ListNotificationsCutoverMetricSink = () => {
  // Default no-op sink: callers can pass their own for telemetry. Tests inject
  // an array-pushing sink to inspect emitted metrics.
};