import { getDatabase, readRecoveryOperationSync } from "@dofe-agent/db";
import { runRecoveryStepSync } from "./recovery.ts";

export interface AdvanceRecoveriesResult {
  /** Operations whose phase advanced this tick. */
  advanced: number;
  /** Operations still waiting on an async handle (provisioning/mount/skill-install). */
  waiting: number;
  /** Operations that failed this tick. */
  failed: number;
}

/**
 * Advances every non-terminal, non-pending-approval recovery operation by ONE
 * phase. Called from the runtime-maintenance cron. Each phase is re-entrant and
 * idempotent: a phase waiting on an async handle (managed provisioning, daemon
 * workspace mount, skill installation) records the handle in context_json and
 * stays in the same phase; the next tick re-checks the handle and advances when
 * it resolves. Bounded by `limit` per tick.
 */
export function advanceRecoverableOperationsSync(input?: {
  workspaceId?: string;
  limit?: number;
}): AdvanceRecoveriesResult {
  const workspaceId = input?.workspaceId;
  const limit = Math.max(1, Math.min(input?.limit ?? 25, 200));

  const rows = getDatabase().prepare(
    `SELECT id, workspace_id AS workspaceId
     FROM employee_recovery_operation
     WHERE phase NOT IN ('completed', 'failed')
       AND (approval_state IS NULL OR approval_state <> 'pending')
     ${workspaceId ? "AND workspace_id = ?" : ""}
     ORDER BY created_at ASC
     LIMIT ${limit}`,
  ).all(...(workspaceId ? [workspaceId] : [])) as Array<{ id: string; workspaceId: string }>;

  let advanced = 0;
  let waiting = 0;
  let failed = 0;

  for (const row of rows) {
    const before = readRecoveryOperationSync(row.id, row.workspaceId)?.phase;
    const result = runRecoveryStepSync({ operationId: row.id, workspaceId: row.workspaceId });
    const after = result.operation.phase;

    if (!result.ok || after === "failed") {
      failed += 1;
    } else if (after !== before) {
      advanced += 1;
    } else {
      waiting += 1;
    }
  }

  return { advanced, waiting, failed };
}
