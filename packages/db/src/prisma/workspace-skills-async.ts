// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workspace-skills-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkspaceSkill, WorkspaceSkillFile } from "@dofe-agent/domain/workspace";

export async function listStoredWorkspaceSkillsAsync(
  workspaceId: string = "default",
): Promise<WorkspaceSkill[]> {
  const skillSql = `SELECT id, workspace_id, name, description, source_type,
                           source_url, config_json, created_at, updated_at
                    FROM skill
                    WHERE workspace_id = $1
                    ORDER BY LOWER(name) ASC, name ASC`;
  const fileSql = `SELECT id, skill_id, path, content, created_at, updated_at
                  FROM skill_file
                  WHERE skill_id IN (SELECT id FROM skill WHERE workspace_id = $1)
                  ORDER BY
                    CASE WHEN lower(path) = lower('SKILL.md') THEN 0 ELSE 1 END,
                    LOWER(path) ASC, path ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const skillRes = await client.query<SkillRow>(skillSql, [workspaceId]);
    const fileRes = await client.query<FileRow>(fileSql, [workspaceId]);
    const filesBySkillId = new Map<string, WorkspaceSkillFile[]>();
    for (const row of fileRes.rows) {
      const list = filesBySkillId.get(row.skill_id) ?? [];
      list.push(mapFileRow(row));
      filesBySkillId.set(row.skill_id, list);
    }
    return skillRes.rows.map((row) => mapSkillRow(row, filesBySkillId.get(row.id) ?? []));
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkspaceSkillsAsyncReadEnabled(): boolean {
  return process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED === "1";
}

export function isWorkspaceSkillsShadowReadEnabled(): boolean {
  return process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED === "1";
}

interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  source_type: string | null;
  source_url: string | null;
  config_json: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FileRow {
  id: string;
  skill_id: string;
  path: string;
  content: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapSkillRow(row: SkillRow, files: WorkspaceSkillFile[]): WorkspaceSkill {
  const record: WorkspaceSkill = {
    id: row.id,
    name: row.name,
    description: row.description,
    files,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.source_type !== null) record.sourceType = row.source_type;
  if (row.source_url !== null) record.sourceUrl = row.source_url;
  if (row.config_json !== null) record.configJson = row.config_json;
  return record;
}

function mapFileRow(row: FileRow): WorkspaceSkillFile {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}