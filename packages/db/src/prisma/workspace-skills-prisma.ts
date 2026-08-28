// workspace-skill Phase 2 真 Prisma Client primary：与前 17 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkspaceSkill, WorkspaceSkillFile } from "@dofe-agent/domain/workspace";

interface PrismaSkill {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  sourceType: string | null;
  sourceUrl: string | null;
  configJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PrismaSkillFile {
  id: string;
  skillId: string;
  path: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listStoredWorkspaceSkillsPrisma(
  workspaceId: string = "default",
  client?: PrismaClient,
): Promise<WorkspaceSkill[]> {
  const prisma = client ?? getDofePrismaClient();
  const skills = await prisma.skill.findMany({
    where: { workspaceId },
    orderBy: [{ name: "asc" }],
  });
  const skillRows = skills as unknown as PrismaSkill[];
  const ids = skillRows.map((s) => s.id);
  const files = ids.length === 0
    ? []
    : await prisma.skillFile.findMany({
        where: { skillId: { in: ids } },
        orderBy: [{ path: "asc" }],
      });
  const filesBySkillId = new Map<string, WorkspaceSkillFile[]>();
  for (const file of files as unknown as PrismaSkillFile[]) {
    const list = filesBySkillId.get(file.skillId) ?? [];
    list.push(mapPrismaFileRow(file));
    filesBySkillId.set(file.skillId, list);
  }
  return skillRows.map((row) => mapPrismaSkillRow(row, filesBySkillId.get(row.id) ?? []));
}

export function isWorkspaceSkillsPrismaReadEnabled(): boolean {
  return process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED === "1";
}

export function isWorkspaceSkillsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setWorkspaceSkillsPrismaClientForTests };

export async function disconnectWorkspaceSkillsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaSkillRow(row: PrismaSkill, files: WorkspaceSkillFile[]): WorkspaceSkill {
  const record: WorkspaceSkill = {
    id: row.id,
    name: row.name,
    description: row.description,
    files,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.sourceType !== null) record.sourceType = row.sourceType;
  if (row.sourceUrl !== null) record.sourceUrl = row.sourceUrl;
  if (row.configJson !== null) record.configJson = row.configJson;
  return record;
}

function mapPrismaFileRow(row: PrismaSkillFile): WorkspaceSkillFile {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}