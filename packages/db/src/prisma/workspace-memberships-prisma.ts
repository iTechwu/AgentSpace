// workspace-memberships Phase 2 真 Prisma Client primary：与 audit-log /
// notifications / task-execution-events 同款双 runner 模式，切流 flag 走
// WORKSPACE_MEMBERSHIPS_PRISMA_*。

import type { PrismaClient } from "@prisma/client";
import type { StoredWorkspaceMembershipRecord } from "../types.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";

/**
 * Override the cached PrismaClient (test/seed path). Pass null to clear.
 */
export function setWorkspaceMembershipsPrismaClientForTests(client: PrismaClient | null): void {
  setDofePrismaClientForTests(client);
}

interface PrismaMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: Date;
  invitedBy: string | null;
}

export async function listWorkspaceMembershipsPrisma(
  workspaceId: string,
  client?: PrismaClient,
): Promise<StoredWorkspaceMembershipRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workspaceMembership.findMany({
    where: { workspaceId, status: "active" },
    orderBy: { joinedAt: "asc" },
  });
  return rows.map((row) => mapPrismaMembership(row as unknown as PrismaMembership));
}

export function isWorkspaceMembershipsPrismaReadEnabled(): boolean {
  return process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED === "1";
}

export function isWorkspaceMembershipsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export async function disconnectWorkspaceMembershipsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaMembership(row: PrismaMembership): StoredWorkspaceMembershipRecord {
  const record: StoredWorkspaceMembershipRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role as StoredWorkspaceMembershipRecord["role"],
    status: row.status as StoredWorkspaceMembershipRecord["status"],
    joinedAt: row.joinedAt.toISOString(),
  };
  if (row.invitedBy !== null) record.invitedBy = row.invitedBy;
  return record;
}
