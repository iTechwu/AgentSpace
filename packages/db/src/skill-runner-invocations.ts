import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { SkillRunnerInvocationRecord } from "./types.ts";

const INVOCATION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, task_id AS taskId, runtime_id AS runtimeId,
  installation_id AS installationId, skill_id AS skillId, skill_name AS skillName,
  artifact_digest AS artifactDigest, revision,
  entrypoint_id AS entrypointId, entrypoint_key AS entrypointKey,
  entrypoint_path AS entrypointPath, entrypoint_runtime AS entrypointRuntime,
  actor_id AS actorId, actor_type AS actorType,
  result_code AS resultCode, timed_out AS timedOut, duration_ms AS durationMs,
  safe_summary AS safeSummary, event_id AS eventId, created_at AS createdAt`;

export interface RecordSkillRunnerInvocationInput {
  workspaceId?: string;
  taskId?: string;
  runtimeId?: string;
  installationId?: string;
  skillId?: string;
  skillName: string;
  artifactDigest: string;
  revision?: string;
  entrypointId: string;
  entrypointKey: string;
  entrypointPath?: string;
  entrypointRuntime?: string;
  actorId: string;
  actorType: string;
  resultCode: number;
  timedOut?: boolean;
  durationMs?: number;
  /** Redacted, short summary safe for the audit log (never raw output/secrets). */
  safeSummary?: string;
  /** Stable daemon-side event id used for idempotent delivery under retry. */
  eventId?: string;
}

/**
 * Persists one Skill Runner entrypoint invocation (daemon-reported). Idempotent
 * per (workspace, eventId): a daemon retry of a lost response replays the same
 * event and the first record wins. Only redacted fields are stored — the audit
 * never receives raw runner output or secrets.
 */
export function recordSkillRunnerInvocationSync(
  input: RecordSkillRunnerInvocationInput,
): SkillRunnerInvocationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const eventId = input.eventId?.trim() || "";
  if (!input.actorId.trim() || !input.skillName.trim() || !input.artifactDigest.trim()) {
    throw new Error("Skill runner invocation actorId, skillName and artifactDigest are required.");
  }
  if (eventId) {
    const existing = readSkillRunnerInvocationByEventSync(eventId, workspaceId);
    if (existing) {
      return existing;
    }
  }
  const id = `sri-${randomLikeId()}`;
  const now = new Date().toISOString();
  const inserted = db.prepare(
    `INSERT INTO skill_runner_invocation (
      id, workspace_id, task_id, runtime_id, installation_id, skill_id, skill_name,
      artifact_digest, revision, entrypoint_id, entrypoint_key, entrypoint_path,
      entrypoint_runtime, actor_id, actor_type, result_code, timed_out, duration_ms,
      safe_summary, event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, event_id) DO NOTHING`,
  ).run(
    id,
    workspaceId,
    input.taskId?.trim() || null,
    input.runtimeId?.trim() || null,
    input.installationId?.trim() || null,
    input.skillId?.trim() || null,
    input.skillName.trim(),
    input.artifactDigest.trim().toLowerCase(),
    input.revision?.trim() || null,
    input.entrypointId.trim(),
    input.entrypointKey.trim(),
    input.entrypointPath?.trim() || null,
    input.entrypointRuntime?.trim() || null,
    input.actorId.trim(),
    input.actorType?.trim() || "agent",
    Math.trunc(input.resultCode),
    input.timedOut === true,
    input.durationMs ?? null,
    input.safeSummary?.trim() || null,
    eventId || null,
    now,
  );
  const row = db.prepare(
    `${INVOCATION_COLUMNS} FROM skill_runner_invocation WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  let record = row ? mapInvocationRecord(row) : null;
  if (!record && eventId) {
    // Concurrent conflict: another request won the event_id race. Read the winner.
    record = readSkillRunnerInvocationByEventSync(eventId, workspaceId);
  }
  if (!record) {
    throw new Error(`Skill runner invocation "${id}" could not be read back.`);
  }
  return record;
}

export function readSkillRunnerInvocationSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillRunnerInvocationRecord | null {
  const row = getDatabase().prepare(
    `${INVOCATION_COLUMNS} FROM skill_runner_invocation WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapInvocationRecord(row) : null;
}

export function readSkillRunnerInvocationByEventSync(
  eventId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillRunnerInvocationRecord | null {
  const row = getDatabase().prepare(
    `${INVOCATION_COLUMNS} FROM skill_runner_invocation WHERE workspace_id = ? AND event_id = ?`,
  ).get(workspaceId, eventId.trim()) as Record<string, unknown> | undefined;
  return row ? mapInvocationRecord(row) : null;
}

export function listSkillRunnerInvocationsSync(options: {
  workspaceId?: string;
  taskId?: string;
  installationId?: string;
  skillId?: string;
  limit?: number;
} = {}): SkillRunnerInvocationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.taskId?.trim()) {
    where.push("task_id = ?");
    params.push(options.taskId.trim());
  }
  if (options.installationId?.trim()) {
    where.push("installation_id = ?");
    params.push(options.installationId.trim());
  }
  if (options.skillId?.trim()) {
    where.push("skill_id = ?");
    params.push(options.skillId.trim());
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const rows = getDatabase().prepare(
    `${INVOCATION_COLUMNS} FROM skill_runner_invocation
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapInvocationRecord).filter((r): r is SkillRunnerInvocationRecord => r !== null);
}

function mapInvocationRecord(value: Record<string, unknown>): SkillRunnerInvocationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.skillName !== "string" ||
    typeof value.artifactDigest !== "string" ||
    typeof value.entrypointId !== "string" ||
    typeof value.entrypointKey !== "string" ||
    typeof value.actorId !== "string" ||
    typeof value.actorType !== "string" ||
    typeof value.resultCode !== "number" ||
    typeof value.timedOut !== "boolean" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
    runtimeId: typeof value.runtimeId === "string" ? value.runtimeId : undefined,
    installationId: typeof value.installationId === "string" ? value.installationId : undefined,
    skillId: typeof value.skillId === "string" ? value.skillId : undefined,
    skillName: value.skillName,
    artifactDigest: value.artifactDigest,
    revision: typeof value.revision === "string" ? value.revision : undefined,
    entrypointId: value.entrypointId,
    entrypointKey: value.entrypointKey,
    entrypointPath: typeof value.entrypointPath === "string" ? value.entrypointPath : undefined,
    entrypointRuntime: typeof value.entrypointRuntime === "string" ? value.entrypointRuntime : undefined,
    actorId: value.actorId,
    actorType: value.actorType,
    resultCode: value.resultCode,
    timedOut: value.timedOut,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    safeSummary: typeof value.safeSummary === "string" ? value.safeSummary : undefined,
    eventId: typeof value.eventId === "string" ? value.eventId : undefined,
    createdAt: value.createdAt,
  };
}
