// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 agent-skills-prisma.ts（同等接口，@prisma/client 真接入）。
//
// agent-skill Phase 2 异步 primary（pg.Client 直连原型）：通过 pg.Client 直连
// PG 拉 agent_skill 行（filter by workspace_id，ORDER BY employee_name ASC +
// skill_id ASC）。skill 表可选 agent_id 列由 hasAgentIdColumn 运行时探测，
// 这里采用固定列对齐，与 sync listStoredAgentSkillAssignmentsSync 一致
// 返回带 agentId 字段的 record。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { StoredAgentSkillRecord } from "../types.ts";

export async function listAgentSkillAssignmentsAsync(
  workspaceId: string,
): Promise<StoredAgentSkillRecord[]> {
  const sql = `SELECT
                workspace_id   AS "workspaceId",
                employee_id    AS "employeeId",
                employee_name  AS "employeeName",
                skill_id       AS "skillId",
                skill_artifact_digest AS "skillArtifactDigest",
                rollout_pin    AS "rolloutPin",
                created_at     AS "createdAt"
              FROM agent_skill
              WHERE workspace_id = $1
              ORDER BY LOWER(employee_name) ASC, employee_name ASC, skill_id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isAgentSkillsAsyncReadEnabled(): boolean {
  return process.env.AGENT_SKILLS_ASYNC_READ_ENABLED === "1";
}

export function isAgentSkillsShadowReadEnabled(): boolean {
  return process.env.AGENT_SKILLS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  skillArtifactDigest: string | null;
  rolloutPin: string | null;
  createdAt: Date | string;
}

function mapRow(row: RawRow): StoredAgentSkillRecord {
  // Sync path always populates agentId from employeeId (the schema may not
  // even have an agent_id column on legacy tables); mirror that behavior so
  // pg 原型 / Prisma / sync 三路 produce identical records.
  const record: StoredAgentSkillRecord = {
    workspaceId: row.workspaceId,
    agentId: row.employeeId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    skillId: row.skillId,
    createdAt: toIsoString(row.createdAt),
  };
  if (row.skillArtifactDigest !== null) record.skillArtifactDigest = row.skillArtifactDigest;
  if (row.rolloutPin !== null) record.rolloutPin = row.rolloutPin;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}