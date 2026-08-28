// channel-participant Phase 2 真 Prisma Client primary：与前 14 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { ChannelParticipantStatus, StoredChannelParticipantRecord } from "../types.ts";

interface PrismaChannelParticipant {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: string;
  addedBy: string | null;
  joinedAt: Date;
  removedAt: Date | null;
  updatedAt: Date;
}

const VALID_STATUSES = new Set(["active", "invited", "removed"]);

export interface ListChannelParticipantsPrismaInput {
  workspaceId: string;
  channelName: string;
  options?: { userId?: string; statuses?: ChannelParticipantStatus[] };
}

export async function listChannelParticipantsPrisma(
  input: ListChannelParticipantsPrismaInput,
  client?: PrismaClient,
): Promise<StoredChannelParticipantRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const statuses = input.options?.statuses?.length
    ? input.options.statuses
    : ["active" as ChannelParticipantStatus];
  const where: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    channelName: input.channelName,
    status: { in: statuses },
  };
  if (input.options?.userId) where.userId = input.options.userId;
  const rows = await prisma.channelParticipant.findMany({
    where,
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaChannelParticipant));
}

export function isChannelParticipantsPrismaReadEnabled(): boolean {
  return process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED === "1";
}

export function isChannelParticipantsPrismaShadowReadEnabled(): boolean {
  return process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setChannelParticipantsPrismaClientForTests };

export async function disconnectChannelParticipantsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaChannelParticipant,
): StoredChannelParticipantRecord {
  const record: StoredChannelParticipantRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    channelName: row.channelName,
    userId: row.userId,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as StoredChannelParticipantRecord["status"])
      : "active",
    joinedAt: row.joinedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.addedBy !== null) record.addedBy = row.addedBy;
  if (row.removedAt) record.removedAt = row.removedAt.toISOString();
  return record;
}