// notifications Phase 2 真 Prisma Client primary：listWorkspaceNotificationsPrisma
// 通过 @prisma/client 替代 pg.Client 直连；切流 flag 走独立 env var
// （NOTIFICATIONS_PRISMA_READ_ENABLED=1 / NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED=1），
// 与 pg 原型 flag（NOTIFICATIONS_ASYNC_*）解耦。

import type { PrismaClient } from "@prisma/client";
import type { ListWorkspaceNotificationsOptions } from "../notifications.ts";
import type { WorkspaceNotificationRecord } from "../types.ts";
import { disconnectDofePrismaClient, getDofePrismaClient, setDofePrismaClientForTests } from "./prisma-client.ts";

/**
 * Override the cached PrismaClient (test/seed path). Pass null to clear.
 */
export function setNotificationsPrismaClientForTests(client: PrismaClient | null): void {
  setDofePrismaClientForTests(client);
}

interface PrismaNotification {
  id: string;
  workspaceId: string;
  recipientType: string;
  recipientId: string;
  actorType: string | null;
  actorId: string | null;
  type: string;
  resourceType: string;
  resourceId: string | null;
  channelName: string | null;
  title: string;
  body: string;
  actionHref: string | null;
  severity: string;
  status: string;
  dedupeKey: string | null;
  metadataJson: unknown;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
}

export async function listWorkspaceNotificationsPrisma(
  options: ListWorkspaceNotificationsOptions,
  client?: PrismaClient,
): Promise<WorkspaceNotificationRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = {
    workspaceId: options.workspaceId ?? "default",
    recipientType: options.recipientType,
    recipientId: options.recipientId,
  };
  if (Array.isArray(options.status)) {
    where.status = { in: options.status };
  } else if (typeof options.status === "string") {
    where.status = options.status;
  } else if (!options.includeArchived) {
    where.status = { not: "archived" };
  }
  const rows = await prisma.workspaceNotification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: normalizePrismaLimit(options.limit),
  });
  return rows
    .map((row) => mapPrismaNotification(row as unknown as PrismaNotification))
    .filter((r): r is WorkspaceNotificationRecord => r !== null);
}

export function isNotificationsPrismaReadEnabled(): boolean {
  return process.env.NOTIFICATIONS_PRISMA_READ_ENABLED === "1";
}

export function isNotificationsPrismaShadowReadEnabled(): boolean {
  return process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export async function disconnectNotificationsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function normalizePrismaLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}

function mapPrismaNotification(
  row: PrismaNotification,
): WorkspaceNotificationRecord | null {
  const record: WorkspaceNotificationRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    recipientType: row.recipientType as WorkspaceNotificationRecord["recipientType"],
    recipientId: row.recipientId,
    type: row.type,
    resourceType: row.resourceType as WorkspaceNotificationRecord["resourceType"],
    title: row.title,
    body: row.body,
    severity: row.severity as WorkspaceNotificationRecord["severity"],
    status: row.status as WorkspaceNotificationRecord["status"],
    metadataJson: serializeJson(row.metadataJson),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.actorType) record.actorType = row.actorType as WorkspaceNotificationRecord["actorType"];
  if (row.actorId !== null) record.actorId = row.actorId;
  if (row.resourceId !== null) record.resourceId = row.resourceId;
  if (row.channelName !== null) record.channelName = row.channelName;
  if (row.actionHref !== null) record.actionHref = row.actionHref;
  if (row.dedupeKey !== null) record.dedupeKey = row.dedupeKey;
  if (row.readAt) record.readAt = row.readAt.toISOString();
  if (row.archivedAt) record.archivedAt = row.archivedAt.toISOString();
  return record;
}

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
