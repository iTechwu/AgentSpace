import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type {
  StoredAgentSkillRecord,
  StoredSkillFileRecord,
  StoredSkillImportEventRecord,
  StoredSkillRecord,
} from "./types.ts";

const DEFAULT_SKILL_SOURCE_TYPE = "manual";
const DEFAULT_SKILL_CONFIG_JSON = "{}";

export function listStoredWorkspaceSkillsSync(workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceSkill[] {
  const db = getDatabase();
  const skillRows = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        name,
        description,
        source_type AS sourceType,
        source_url AS sourceUrl,
        config_json AS configJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM skill
      WHERE workspace_id = ?
      ORDER BY LOWER(name) ASC, name ASC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  const fileRows = db
    .prepare(
      `SELECT
        sf.id,
        sf.skill_id AS skillId,
        sf.path,
        sf.content,
        sf.created_at AS createdAt,
        sf.updated_at AS updatedAt
      FROM skill_file sf
      JOIN skill s ON s.id = sf.skill_id
      WHERE s.workspace_id = ?
      ORDER BY
        CASE WHEN lower(sf.path) = lower('SKILL.md') THEN 0 ELSE 1 END,
        LOWER(sf.path) ASC, sf.path ASC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  const skills = skillRows
    .map((row) => mapStoredSkillRecord(row))
    .filter((row): row is StoredSkillRecord => row !== null);
  const files = fileRows
    .map((row) => mapStoredSkillFileRecord(row))
    .filter((row): row is StoredSkillFileRecord => row !== null);
  const filesBySkillId = new Map<string, StoredSkillFileRecord[]>();
  for (const file of files) {
    const next = filesBySkillId.get(file.skillId) ?? [];
    next.push(file);
    filesBySkillId.set(file.skillId, next);
  }

  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
    configJson: skill.configJson,
    files: filesBySkillId.get(skill.id)?.map((file) => ({
      id: file.id,
      path: file.path,
      content: file.content,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    })) ?? [],
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }));
}

export function readStoredWorkspaceSkillSync(skillId: string, workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceSkill | null {
  return listStoredWorkspaceSkillsSync(workspaceId).find((skill) => skill.id === skillId) ?? null;
}

export function listStoredAgentSkillAssignmentsSync(workspaceId = DEFAULT_WORKSPACE_ID): StoredAgentSkillRecord[] {
  const db = getDatabase();
  const hasAgentIdColumn = agentSkillTableHasAgentIdColumn(db);
  const rows = db
    .prepare(
      `SELECT
        workspace_id AS workspaceId,
        ${hasAgentIdColumn ? "agent_id" : "NULL"} AS agentId,
        employee_name AS employeeName,
        skill_id AS skillId,
        skill_artifact_digest AS skillartifactdigest,
        rollout_pin AS rolloutpin,
        created_at AS createdAt
      FROM agent_skill
      WHERE workspace_id = ?
      ORDER BY LOWER(employee_name) ASC, employee_name ASC, skill_id ASC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapStoredAgentSkillRecord(row))
    .filter((row): row is StoredAgentSkillRecord => row !== null);
}

export function readStoredSkillActiveArtifactDigestSync(skillId: string, workspaceId = DEFAULT_WORKSPACE_ID): string | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT active_artifact_digest AS activeartifactdigest
       FROM skill
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, skillId) as Record<string, unknown> | undefined;
  return typeof row?.activeartifactdigest === "string" ? row.activeartifactdigest : null;
}
export function recordStoredSkillImportEventSync(input: {
  workspaceId?: string;
  skillId?: string;
  skillName: string;
  sourceType: string;
  sourceUrl?: string;
  importMode: "created" | "renamed" | "replaced";
  metadataJson?: string;
  importedAt?: string;
}): StoredSkillImportEventRecord {
  const db = getDatabase();
  const id = `skill-import-${randomLikeId()}`;
  const importedAt = input.importedAt ?? new Date().toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const metadataJson = input.metadataJson?.trim() || "{}";

  db.prepare(
    `INSERT INTO skill_import_event (
      id,
      workspace_id,
      skill_id,
      skill_name,
      source_type,
      source_url,
      import_mode,
      metadata_json,
      imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.skillId?.trim() || null,
    input.skillName.trim(),
    input.sourceType.trim(),
    input.sourceUrl?.trim() || null,
    input.importMode,
    metadataJson,
    importedAt,
  );

  return {
    id,
    workspaceId,
    skillId: input.skillId?.trim() || undefined,
    skillName: input.skillName.trim(),
    sourceType: input.sourceType.trim(),
    sourceUrl: input.sourceUrl?.trim() || undefined,
    importMode: input.importMode,
    metadataJson,
    importedAt,
  };
}

export function listStoredSkillImportEventsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  limit = 20,
): StoredSkillImportEventRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      skill_id AS skillId,
      skill_name AS skillName,
      source_type AS sourceType,
      source_url AS sourceUrl,
      import_mode AS importMode,
      metadata_json AS metadataJson,
      imported_at AS importedAt
     FROM skill_import_event
     WHERE workspace_id = ?
     ORDER BY imported_at DESC, id DESC
     LIMIT ?`,
  ).all(workspaceId, limit) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapStoredSkillImportEventRecord(row))
    .filter((row): row is StoredSkillImportEventRecord => row !== null);
}

export function replaceStoredWorkspaceSkillsSync(
  skills: WorkspaceSkill[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): void {
  const db = getDatabase();

  withTransaction(db, () => {
    db.prepare("DELETE FROM skill WHERE workspace_id = ?").run(workspaceId);
    for (const skill of skills) {
      db.prepare(
        `INSERT INTO skill (
          id,
          workspace_id,
          name,
          description,
          source_type,
          source_url,
          config_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        skill.id,
        workspaceId,
        skill.name,
        skill.description,
        skill.sourceType?.trim() || DEFAULT_SKILL_SOURCE_TYPE,
        skill.sourceUrl?.trim() || null,
        skill.configJson?.trim() || DEFAULT_SKILL_CONFIG_JSON,
        skill.createdAt,
        skill.updatedAt,
      );

      for (const file of skill.files) {
        db.prepare(
          `INSERT INTO skill_file (
            id,
            skill_id,
            path,
            content,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(file.id, skill.id, file.path, file.content, file.createdAt, file.updatedAt);
      }
    }
  });
}

export function createStoredWorkspaceSkillSync(skill: WorkspaceSkill, workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceSkill {
  const db = getDatabase();

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO skill (
        id,
        workspace_id,
        name,
        description,
        source_type,
        source_url,
        config_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      skill.id,
      workspaceId,
      skill.name,
      skill.description,
      skill.sourceType?.trim() || DEFAULT_SKILL_SOURCE_TYPE,
      skill.sourceUrl?.trim() || null,
      skill.configJson?.trim() || DEFAULT_SKILL_CONFIG_JSON,
      skill.createdAt,
      skill.updatedAt,
    );

    for (const file of skill.files) {
      db.prepare(
        `INSERT INTO skill_file (
          id,
          skill_id,
          path,
          content,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(file.id, skill.id, file.path, file.content, file.createdAt, file.updatedAt);
    }
  });

  return readStoredWorkspaceSkillSync(skill.id, workspaceId) ?? skill;
}

export function updateStoredWorkspaceSkillMetaSync(
  input: {
    skillId: string;
    name: string;
    description: string;
    sourceType?: string;
    sourceUrl?: string;
    configJson?: string;
    updatedAt: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceSkill | null {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE skill
       SET name = ?,
           description = ?,
           source_type = ?,
           source_url = ?,
           config_json = ?,
           updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    )
    .run(
      input.name,
      input.description,
      input.sourceType?.trim() || DEFAULT_SKILL_SOURCE_TYPE,
      input.sourceUrl?.trim() || null,
      input.configJson?.trim() || DEFAULT_SKILL_CONFIG_JSON,
      input.updatedAt,
      workspaceId,
      input.skillId,
    );
  if (result.changes === 0) {
    return null;
  }
  return readStoredWorkspaceSkillSync(input.skillId, workspaceId);
}

export function upsertStoredWorkspaceSkillFileSync(
  input: {
    skillId: string;
    file: {
      id: string;
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    };
    skillUpdatedAt: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceSkill | null {
  const db = getDatabase();

  withTransaction(db, () => {
    const skillExists = db
      .prepare("SELECT id FROM skill WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, input.skillId) as { id: string } | undefined;
    if (!skillExists) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }

    db.prepare(
      `INSERT INTO skill_file (
        id,
        skill_id,
        path,
        content,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        content = excluded.content,
        updated_at = excluded.updated_at`,
    ).run(
      input.file.id,
      input.skillId,
      input.file.path,
      input.file.content,
      input.file.createdAt,
      input.file.updatedAt,
    );

    db.prepare(
      `UPDATE skill
       SET updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(input.skillUpdatedAt, workspaceId, input.skillId);
  });

  return readStoredWorkspaceSkillSync(input.skillId, workspaceId);
}

export function deleteStoredWorkspaceSkillFileSync(
  skillId: string,
  fileId: string,
  skillUpdatedAt: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceSkill | null {
  const db = getDatabase();

  withTransaction(db, () => {
    const result = db
      .prepare(
        `DELETE FROM skill_file
         WHERE id = ? AND skill_id = ?`,
      )
      .run(fileId, skillId);
    if (result.changes === 0) {
      throw new Error(`Skill file "${fileId}" does not exist.`);
    }

    db.prepare(
      `UPDATE skill
       SET updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(skillUpdatedAt, workspaceId, skillId);
  });

  return readStoredWorkspaceSkillSync(skillId, workspaceId);
}

export function deleteStoredWorkspaceSkillSync(skillId: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `DELETE FROM skill
       WHERE workspace_id = ? AND id = ?`,
    )
    .run(workspaceId, skillId);
  return result.changes > 0;
}

export function replaceStoredAgentSkillAssignmentsSync(
  assignments: Array<{ employeeName: string; skillIds: string[] }>,
  workspaceId = DEFAULT_WORKSPACE_ID,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const hasAgentIdColumn = agentSkillTableHasAgentIdColumn(db);

  withTransaction(db, () => {
    db.prepare("DELETE FROM agent_skill_requirement_config WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM agent_skill WHERE workspace_id = ?").run(workspaceId);
    for (const assignment of assignments) {
      const employeeId = resolveEmployeeIdForWrite(assignment.employeeName, workspaceId);
      for (const skillId of assignment.skillIds) {
        if (hasAgentIdColumn) {
          db.prepare(
            `INSERT INTO agent_skill (
              workspace_id,
              agent_id,
              employee_id,
              employee_name,
              skill_id,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(workspaceId, buildLegacyAgentId(assignment.employeeName), employeeId, assignment.employeeName, skillId, now);
        } else {
          db.prepare(
            `INSERT INTO agent_skill (
              workspace_id,
              employee_id,
              employee_name,
              skill_id,
              created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          ).run(workspaceId, employeeId, assignment.employeeName, skillId, now);
        }
      }
    }
  });
}

export function setStoredEmployeeSkillAssignmentsSync(
  employeeName: string,
  skillIds: string[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const hasAgentIdColumn = agentSkillTableHasAgentIdColumn(db);

  withTransaction(db, () => {
    if (skillIds.length === 0) {
      db.prepare(
        `DELETE FROM agent_skill_requirement_config
         WHERE workspace_id = ? AND employee_name = ?`,
      ).run(workspaceId, employeeName);
    } else {
      const placeholders = skillIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM agent_skill_requirement_config
         WHERE workspace_id = ? AND employee_name = ? AND skill_id NOT IN (${placeholders})`,
      ).run(workspaceId, employeeName, ...skillIds);
    }
    db.prepare(
      `DELETE FROM agent_skill
       WHERE workspace_id = ? AND employee_name = ?`,
    ).run(workspaceId, employeeName);

    const activeDigests = new Map<string, string | undefined>();
    if (skillIds.length > 0) {
      const placeholders = skillIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT id, active_artifact_digest AS activeartifactdigest
           FROM skill
           WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .all(workspaceId, ...skillIds) as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (typeof row.id === "string") {
          activeDigests.set(row.id, typeof row.activeartifactdigest === "string" ? row.activeartifactdigest : undefined);
        }
      }
    }

    const employeeId = resolveEmployeeIdForWrite(employeeName, workspaceId);
    for (const skillId of skillIds) {
      const digest = activeDigests.get(skillId);
      if (hasAgentIdColumn) {
        db.prepare(
          `INSERT INTO agent_skill (
            workspace_id,
            agent_id,
            employee_id,
            employee_name,
            skill_id,
            skill_artifact_digest,
            rollout_pin,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(workspaceId, buildLegacyAgentId(employeeName), employeeId, employeeName, skillId, digest ?? null, now);
      } else {
        db.prepare(
          `INSERT INTO agent_skill (
            workspace_id,
            employee_id,
            employee_name,
            skill_id,
            skill_artifact_digest,
            rollout_pin,
            created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        ).run(workspaceId, employeeId, employeeName, skillId, digest ?? null, now);
      }
    }
  });
}

/**
 * Rolls out a skill revision to every employee assignment: updates `rollout_pin`
 * so NEW tasks resolve to the pinned installation revision. Clears the pin with
 * a null revision (tasks then resolve to the highest ready revision).
 */
export function setSkillRolloutPinSync(input: {
  workspaceId?: string;
  skillId: string;
  revision: string | null;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE agent_skill SET rollout_pin = ? WHERE workspace_id = ? AND skill_id = ?`,
  ).run(input.revision?.trim() || null, workspaceId, input.skillId);
  return result.changes;
}

/** Pins a single employee's assignment to a rollout revision. */
export function setEmployeeSkillRolloutPinSync(input: {
  workspaceId?: string;
  employeeName: string;
  skillId: string;
  revision: string | null;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE agent_skill SET rollout_pin = ?
     WHERE workspace_id = ? AND employee_name = ? AND skill_id = ?`,
  ).run(input.revision?.trim() || null, workspaceId, input.employeeName.trim(), input.skillId);
  return result.changes;
}

export function resetStoredWorkspaceSkillsSync(workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  withTransaction(db, () => {
    db.prepare("DELETE FROM agent_skill_requirement_config WHERE workspace_id = ?").run(workspaceId);
    db.prepare(
      `DELETE FROM agent_skill
       WHERE workspace_id = ?`,
    ).run(workspaceId);
    db.prepare(
      `DELETE FROM skill
       WHERE workspace_id = ?`,
    ).run(workspaceId);
  });
}

function mapStoredSkillRecord(value: Record<string, unknown>): StoredSkillRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.sourceType !== "string" ||
    typeof value.configJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    name: value.name,
    description: value.description,
    sourceType: value.sourceType,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : undefined,
    configJson: value.configJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapStoredSkillFileRecord(value: Record<string, unknown>): StoredSkillFileRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.skillId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.content !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    skillId: value.skillId,
    path: value.path,
    content: value.content,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapStoredAgentSkillRecord(value: Record<string, unknown>): StoredAgentSkillRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.skillId !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    agentId: typeof value.agentId === "string" ? value.agentId : undefined,
    employeeName: value.employeeName,
    skillId: value.skillId,
    skillArtifactDigest: typeof value.skillartifactdigest === "string" ? value.skillartifactdigest : undefined,
    rolloutPin: typeof value.rolloutpin === "string" && value.rolloutpin.length > 0 ? value.rolloutpin : undefined,
    createdAt: value.createdAt,
  };
}

function buildLegacyAgentId(employeeName: string): string {
  return `agent:${employeeName.trim()}`;
}

function agentSkillTableHasAgentIdColumn(_db: ReturnType<typeof getDatabase>): boolean {
  return true;
}

function mapStoredSkillImportEventRecord(value: Record<string, unknown>): StoredSkillImportEventRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.skillName !== "string" ||
    typeof value.sourceType !== "string" ||
    (value.importMode !== "created" && value.importMode !== "renamed" && value.importMode !== "replaced") ||
    typeof value.metadataJson !== "string" ||
    typeof value.importedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    skillId: typeof value.skillId === "string" ? value.skillId : undefined,
    skillName: value.skillName,
    sourceType: value.sourceType,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : undefined,
    importMode: value.importMode,
    metadataJson: value.metadataJson,
    importedAt: value.importedAt,
  };
}

/** Resolves the stable employee id for a write; the employee must exist. */
function resolveEmployeeIdForWrite(employeeName: string, workspaceId: string): string {
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) {
    throw new Error(`Employee "${employeeName}" does not exist in workspace ${workspaceId}.`);
  }
  return employeeId;
}
