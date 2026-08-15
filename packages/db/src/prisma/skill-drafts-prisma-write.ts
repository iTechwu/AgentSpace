// skill-draft Phase 2 真 Prisma Client write path：upsertSkillDraftPrisma
// 复刻 sync 的 ON CONFLICT (workspace_id, skill_id) DO UPDATE 语义
// （复合主键 @@id([workspaceId, skillId])，Prisma upsert 可表达）。
// cutover 走 buildDomainWriteCutover：primary 抛错 fail closed 不重写。

import type { PrismaClient } from "@prisma/client";
import { DEFAULT_WORKSPACE_ID } from "../database.ts";
import {
  deleteSkillDraftSync,
  upsertSkillDraftSync,
} from "../skill-drafts.ts";
import type { SkillDraftRecord } from "../skill-drafts.ts";
import {
  buildDomainWriteCutover,
  type DomainWriteCutoverMetric,
} from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
// Reuse the shared PrismaClient singleton + setter so mock injection covers
// read and write without duplicating the cache plumbing.
import { getDofePrismaClient, setDofePrismaClientForTests } from "./prisma-client.ts";

export function isSkillDraftsPrismaWriteEnabled(): boolean {
  return process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED === "1";
}

// Re-export so callers (tests / shutdown paths) only import this module.
export { setDofePrismaClientForTests as setSkillDraftsPrismaClientForTests };

export interface UpsertSkillDraftInput {
  workspaceId?: string;
  skillId: string;
  draftJson: string;
  updatedByUserId?: string;
}

/**
 * Direct Prisma upsert. Returns the persisted row. Mirrors
 * upsertSkillDraftSync（updatedByUserId trim 后为空则存 NULL）。
 */
export async function upsertSkillDraftPrisma(
  input: UpsertSkillDraftInput,
  client?: PrismaClient,
): Promise<SkillDraftRecord> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const updatedByUserId = input.updatedByUserId?.trim() || null;
  const row = await prisma.skillDraft.upsert({
    where: { workspaceId_skillId: { workspaceId, skillId: input.skillId } },
    create: {
      workspaceId,
      skillId: input.skillId,
      draftJson: input.draftJson,
      updatedByUserId,
      updatedAt: new Date(),
    },
    update: {
      draftJson: input.draftJson,
      updatedByUserId,
      updatedAt: new Date(),
    },
  });
  return mapRowToRecord(row);
}

/**
 * Direct Prisma delete. Returns true when a row was removed.
 * Mirrors deleteSkillDraftSync。
 */
export async function deleteSkillDraftPrisma(
  input: { workspaceId?: string; skillId: string },
  client?: PrismaClient,
): Promise<boolean> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = await prisma.skillDraft.deleteMany({
    where: { workspaceId, skillId: input.skillId },
  });
  return result.count > 0;
}

export type SkillDraftWritePrismaCutoverMetric = DomainWriteCutoverMetric;
export type SkillDraftWritePrismaCutoverMetricSink = (
  metric: SkillDraftWritePrismaCutoverMetric,
) => void;

const upsertSkillDraftPrismaCutoverImpl = buildDomainWriteCutover<
  UpsertSkillDraftInput,
  SkillDraftRecord,
  SkillDraftWritePrismaCutoverMetric
>({
  isEnabled: isSkillDraftsPrismaWriteEnabled,
  runPrimary: async (input) => upsertSkillDraftPrisma(input),
  runFallback: (input) => upsertSkillDraftSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "skill_draft",
    operation: "upsert",
  }),
});

const deleteSkillDraftPrismaCutoverImpl = buildDomainWriteCutover<
  { workspaceId?: string; skillId: string },
  boolean,
  SkillDraftWritePrismaCutoverMetric
>({
  isEnabled: isSkillDraftsPrismaWriteEnabled,
  runPrimary: async (input) => deleteSkillDraftPrisma(input),
  runFallback: (input) =>
    deleteSkillDraftSync(input.skillId, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "skill_draft",
    operation: "delete",
  }),
});

/**
 * Write cutover for skill-draft upsert.
 */
export function upsertSkillDraftPrismaCutover(
  input: UpsertSkillDraftInput,
  metricSink?: SkillDraftWritePrismaCutoverMetricSink,
): Promise<SkillDraftRecord> {
  return upsertSkillDraftPrismaCutoverImpl(input, metricSink);
}

/**
 * Write cutover for skill-draft delete.
 */
export function deleteSkillDraftPrismaCutover(
  input: { workspaceId?: string; skillId: string },
  metricSink?: SkillDraftWritePrismaCutoverMetricSink,
): Promise<boolean> {
  return deleteSkillDraftPrismaCutoverImpl(input, metricSink);
}

interface PrismaSkillDraftRow {
  workspaceId: string;
  skillId: string;
  draftJson: string;
  updatedByUserId: string | null;
  updatedAt: Date;
}

function mapRowToRecord(row: PrismaSkillDraftRow): SkillDraftRecord {
  const record: SkillDraftRecord = {
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    draftJson: row.draftJson,
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.updatedByUserId !== null) record.updatedByUserId = row.updatedByUserId;
  return record;
}
