// agent-access-request Phase 2 真 Prisma Client primary：与前 10 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { AgentAccessRequestRecord } from "../types.ts";

const VALID_TYPES = new Set(["fork_copy", "channel_use"]);
const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

interface PrismaAgentAccessRequest {
  id: string;
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType: string;
  targetChannelName: string | null;
  status: string;
  reason: string;
  resolverUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  forkInvitationId: string | null;
  auditDataJson: unknown;
}

export interface ListAgentAccessRequestsPrismaInput {
  workspaceId: string;
  options?: {
    sourceAgentName?: string;
    requesterUserId?: string;
    requestType?: AgentAccessRequestRecord["requestType"];
    statuses?: AgentAccessRequestRecord["status"][];
  };
}

export async function listAgentAccessRequestsPrisma(
  input: ListAgentAccessRequestsPrismaInput,
  client?: PrismaClient,
): Promise<AgentAccessRequestRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = { workspaceId: input.workspaceId };
  if (input.options?.sourceAgentName?.trim()) {
    where.sourceAgentName = input.options.sourceAgentName.trim();
  }
  if (input.options?.requesterUserId?.trim()) {
    where.requesterUserId = input.options.requesterUserId.trim();
  }
  if (input.options?.requestType) where.requestType = input.options.requestType;
  if (input.options?.statuses?.length) {
    where.status = { in: input.options.statuses };
  }
  const rows = await prisma.agentAccessRequest.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaAgentAccessRequest))
    .filter((r): r is AgentAccessRequestRecord => r !== null);
}

export function isAgentAccessRequestsPrismaReadEnabled(): boolean {
  return process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED === "1";
}

export function isAgentAccessRequestsPrismaShadowReadEnabled(): boolean {
  return process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setAgentAccessRequestsPrismaClientForTests };

export async function disconnectAgentAccessRequestsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaAgentAccessRequest,
): AgentAccessRequestRecord | null {
  if (!VALID_TYPES.has(row.requestType)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: AgentAccessRequestRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceAgentName: row.sourceAgentName,
    requesterUserId: row.requesterUserId,
    requestType: row.requestType as AgentAccessRequestRecord["requestType"],
    status: row.status as AgentAccessRequestRecord["status"],
    reason: row.reason,
    auditDataJson: serializeJson(row.auditDataJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.targetChannelName !== null) record.targetChannelName = row.targetChannelName;
  if (row.resolverUserId !== null) record.resolverUserId = row.resolverUserId;
  if (row.resolvedAt) record.resolvedAt = row.resolvedAt.toISOString();
  if (row.forkInvitationId !== null) record.forkInvitationId = row.forkInvitationId;
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