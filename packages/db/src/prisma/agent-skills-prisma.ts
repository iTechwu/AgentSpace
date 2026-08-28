// agent-skill Phase 2 真 Prisma Client primary：listAgentSkillAssignmentsPrisma
// 通过参数化 raw query 保持 LOWER(employee_name) 排序；复用 prisma-client.ts 共享单例。
//
// 注意 agent_skill 表的 PK 是 (workspace_id, employee_id, skill_id)，但 sync
// path 把 employeeId 作为记录身份（agentId 是 employeeId 的别名）；这里按
// (workspace_id, employee_id, skill_id) 复合 PK 暴露 Prisma 模型，并通过
// mapPrismaRow 在记录层填充 agentId = employeeId 以与 sync 形态对齐。

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { StoredAgentSkillRecord } from "../types.ts";

interface PrismaAgentSkill {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  skillArtifactDigest: string | null;
  rolloutPin: string | null;
  createdAt: Date;
}

export async function listAgentSkillAssignmentsPrisma(
  workspaceId: string,
  client?: PrismaClient,
): Promise<StoredAgentSkillRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.$queryRaw<PrismaAgentSkill[]>(Prisma.sql`
    SELECT
      workspace_id AS "workspaceId",
      COALESCE(agent_id, employee_id) AS "agentId",
      employee_id AS "employeeId",
      employee_name AS "employeeName",
      skill_id AS "skillId",
      skill_artifact_digest AS "skillArtifactDigest",
      rollout_pin AS "rolloutPin",
      created_at AS "createdAt"
    FROM agent_skill
    WHERE workspace_id = ${workspaceId}
    ORDER BY LOWER(employee_name) ASC, employee_name ASC, skill_id ASC
  `);
  return rows.map(mapPrismaRow);
}

export function isAgentSkillsPrismaReadEnabled(): boolean {
  return process.env.AGENT_SKILLS_PRISMA_READ_ENABLED === "1";
}

export function isAgentSkillsPrismaShadowReadEnabled(): boolean {
  return process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setAgentSkillsPrismaClientForTests };

export async function disconnectAgentSkillsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaAgentSkill): StoredAgentSkillRecord {
  const record: StoredAgentSkillRecord = {
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    skillId: row.skillId,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.skillArtifactDigest !== null) record.skillArtifactDigest = row.skillArtifactDigest;
  if (row.rolloutPin !== null) record.rolloutPin = row.rolloutPin;
  return record;
}
