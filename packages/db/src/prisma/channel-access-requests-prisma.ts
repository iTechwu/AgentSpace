// channel-access-request Phase 2 真 Prisma Client primary：与前 15 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type {
  ChannelAccessRequestStatus,
  StoredChannelAccessRequestRecord,
} from "../types.ts";

interface PrismaChannelAccessRequest {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  note: string | null;
}

const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

export interface ListChannelAccessRequestsPrismaInput {
  workspaceId: string;
  options?: {
    channelName?: string;
    userId?: string;
    statuses?: ChannelAccessRequestStatus[];
  };
}

export async function listChannelAccessRequestsPrisma(
  input: ListChannelAccessRequestsPrismaInput,
  client?: PrismaClient,
): Promise<StoredChannelAccessRequestRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const statuses = input.options?.statuses?.length
    ? input.options.statuses
    : ["pending" as ChannelAccessRequestStatus];
  const where: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    status: { in: statuses },
  };
  if (input.options?.channelName) where.channelName = input.options.channelName;
  if (input.options?.userId) where.userId = input.options.userId;
  const rows = await prisma.channelAccessRequest.findMany({
    where,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaChannelAccessRequest));
}

export function isChannelAccessRequestsPrismaReadEnabled(): boolean {
  return process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED === "1";
}

export function isChannelAccessRequestsPrismaShadowReadEnabled(): boolean {
  return process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setChannelAccessRequestsPrismaClientForTests };

export async function disconnectChannelAccessRequestsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaChannelAccessRequest,
): StoredChannelAccessRequestRecord {
  const record: StoredChannelAccessRequestRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    channelName: row.channelName,
    userId: row.userId,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as ChannelAccessRequestStatus)
      : "pending",
    requestedAt: row.requestedAt.toISOString(),
  };
  if (row.resolvedAt) record.resolvedAt = row.resolvedAt.toISOString();
  if (row.resolvedBy !== null) record.resolvedBy = row.resolvedBy;
  if (row.note !== null) record.note = row.note;
  return record;
}