// channel-invitation Phase 2 真 Prisma Client primary：与前 16 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type {
  ChannelInvitationStatus,
  StoredChannelInvitationRecord,
} from "../types.ts";

interface PrismaChannelInvitation {
  id: string;
  workspaceId: string;
  channelName: string;
  inviteeUserId: string | null;
  inviteeEmail: string | null;
  invitedBy: string;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  respondedAt: Date | null;
  respondedBy: string | null;
}

const VALID_STATUSES = new Set(["pending", "accepted", "rejected", "revoked", "expired"]);

export interface ListChannelInvitationsPrismaInput {
  workspaceId: string;
  options?: {
    channelName?: string;
    inviteeUserId?: string;
    inviteeEmail?: string;
    statuses?: ChannelInvitationStatus[];
  };
}

export async function listChannelInvitationsPrisma(
  input: ListChannelInvitationsPrismaInput,
  client?: PrismaClient,
): Promise<StoredChannelInvitationRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const statuses = input.options?.statuses?.length
    ? input.options.statuses
    : ["pending" as ChannelInvitationStatus];
  const where: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    status: { in: statuses },
  };
  if (input.options?.channelName) where.channelName = input.options.channelName;
  if (input.options?.inviteeUserId) where.inviteeUserId = input.options.inviteeUserId;
  if (input.options?.inviteeEmail) where.inviteeEmail = input.options.inviteeEmail;
  const rows = await prisma.channelInvitation.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaChannelInvitation));
}

export function isChannelInvitationsPrismaReadEnabled(): boolean {
  return process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED === "1";
}

export function isChannelInvitationsPrismaShadowReadEnabled(): boolean {
  return process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setChannelInvitationsPrismaClientForTests };

export async function disconnectChannelInvitationsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaChannelInvitation,
): StoredChannelInvitationRecord {
  const record: StoredChannelInvitationRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    channelName: row.channelName,
    invitedBy: row.invitedBy,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as ChannelInvitationStatus)
      : "pending",
    createdAt: row.createdAt.toISOString(),
  };
  if (row.inviteeUserId !== null) record.inviteeUserId = row.inviteeUserId;
  if (row.inviteeEmail !== null) record.inviteeEmail = row.inviteeEmail;
  if (row.expiresAt) record.expiresAt = row.expiresAt.toISOString();
  if (row.respondedAt) record.respondedAt = row.respondedAt.toISOString();
  if (row.respondedBy !== null) record.respondedBy = row.respondedBy;
  return record;
}