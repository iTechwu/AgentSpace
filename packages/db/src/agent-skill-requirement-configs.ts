import { DEFAULT_WORKSPACE_ID, getDatabase } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type { StoredAgentSkillRequirementConfigRecord } from "./types.ts";

export function readAgentSkillRequirementConfigSync(input: {
  workspaceId?: string;
  employeeName: string;
  skillId: string;
}): StoredAgentSkillRequirementConfigRecord | null {
  const row = getDatabase().prepare(
    `SELECT workspace_id AS "workspaceId", employee_name AS "employeeName", skill_id AS "skillId",
            config_json AS "configJson", encrypted_secrets_json AS "encryptedSecretsJson",
            created_by_user_id AS "createdByUserId", updated_by_user_id AS "updatedByUserId",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM agent_skill_requirement_config
      WHERE workspace_id = ? AND employee_name = ? AND skill_id = ?`,
  ).get(input.workspaceId ?? DEFAULT_WORKSPACE_ID, input.employeeName.trim(), input.skillId.trim());
  return row ? mapRecord(row) : null;
}

export function upsertAgentSkillRequirementConfigSync(input: {
  workspaceId?: string;
  employeeName: string;
  skillId: string;
  configJson: string;
  encryptedSecretsJson: string;
  actorUserId?: string;
}): StoredAgentSkillRequirementConfigRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const employeeName = input.employeeName.trim();
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) {
    throw new Error(`Employee "${employeeName}" does not exist in workspace ${workspaceId}.`);
  }
  getDatabase().prepare(
    `INSERT INTO agent_skill_requirement_config (
       workspace_id, employee_id, employee_name, skill_id, config_json, encrypted_secrets_json,
       created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, employee_name, skill_id) DO UPDATE SET
       config_json = EXCLUDED.config_json,
       encrypted_secrets_json = EXCLUDED.encrypted_secrets_json,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = EXCLUDED.updated_at`,
  ).run(workspaceId, employeeId, employeeName, input.skillId.trim(), input.configJson, input.encryptedSecretsJson, input.actorUserId ?? null, input.actorUserId ?? null, now, now);
  const record = readAgentSkillRequirementConfigSync({ workspaceId, employeeName: input.employeeName, skillId: input.skillId });
  if (!record) throw new Error("Agent skill requirement configuration could not be read back.");
  return record;
}

export function deleteAgentSkillRequirementConfigSync(input: { workspaceId?: string; employeeName: string; skillId: string }): void {
  getDatabase().prepare(
    `DELETE FROM agent_skill_requirement_config WHERE workspace_id = ? AND employee_name = ? AND skill_id = ?`,
  ).run(input.workspaceId ?? DEFAULT_WORKSPACE_ID, input.employeeName.trim(), input.skillId.trim());
}

function mapRecord(value: Record<string, unknown>): StoredAgentSkillRequirementConfigRecord | null {
  return typeof value.workspaceId === "string" && typeof value.employeeName === "string" && typeof value.skillId === "string"
    && typeof value.configJson === "string" && typeof value.encryptedSecretsJson === "string"
    && typeof value.createdAt === "string" && typeof value.updatedAt === "string"
    ? {
      workspaceId: value.workspaceId, employeeName: value.employeeName, skillId: value.skillId,
      configJson: value.configJson, encryptedSecretsJson: value.encryptedSecretsJson,
      createdByUserId: typeof value.createdByUserId === "string" ? value.createdByUserId : undefined,
      updatedByUserId: typeof value.updatedByUserId === "string" ? value.updatedByUserId : undefined,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    }
    : null;
}
