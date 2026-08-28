// skill-draft Phase 2 真 Prisma Client write path：upsertSkillDraftPrisma
// 复刻 sync 的 ON CONFLICT (workspace_id, skill_id) DO UPDATE 语义
// （复合主键 @@id([workspaceId, skillId])，Prisma upsert 可表达）。
// cutover 走 buildDomainWriteCutover：primary 抛错 fail closed 不重写。

import type { Prisma, PrismaClient } from "@prisma/client";
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
  // draft_json 列为 jsonb：直接把字符串赋给 Json 字段会按 JSON 字符串标量
  // 二次编码，与 sync 路径（text→jsonb 单层对象）不一致，读回 parse 即失败
  // （audit-log/notifications 的 Prisma 写面同款 parse 惯例）。
  const draftJsonValue = toInputJsonValue(input.draftJson);
  const row = await prisma.skillDraft.upsert({
    where: { workspaceId_skillId: { workspaceId, skillId: input.skillId } },
    create: {
      workspaceId,
      skillId: input.skillId,
      draftJson: draftJsonValue,
      updatedByUserId,
      updatedAt: new Date(),
    },
    update: {
      draftJson: draftJsonValue,
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
  // 3.2-7 后 draft_json 列为 jsonb：写入侧仍收字符串，读回是 JsonValue，
  // 统一字符串化以保持 SkillDraftRecord 的 string 契约。
  draftJson: string | number | boolean | object | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

function mapRowToRecord(row: PrismaSkillDraftRow): SkillDraftRecord {
  const record: SkillDraftRecord = {
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    draftJson: typeof row.draftJson === "string" ? row.draftJson : JSON.stringify(row.draftJson ?? null),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.updatedByUserId !== null) record.updatedByUserId = row.updatedByUserId;
  return record;
}

/** parse 失败（极端非 JSON 输入）时原样存字符串，不放大失败。 */
function toInputJsonValue(value: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(value) as Prisma.InputJsonValue;
  } catch {
    return value;
  }
}
