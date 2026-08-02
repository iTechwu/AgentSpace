import {
  isDaemonProvider,
  type DaemonProvider,
  type TaskSkillExecutionSnapshot,
  type TaskSkillExecutionSnapshotEntry,
} from "@dofe-agent/domain";
import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID, withTransaction } from "./database.ts";
import { type QueuedTaskRecord, type EnqueueTaskInput, isNativeTaskStatus, priorityToNumber } from "./types.ts";
import { readEmployeeBindingGenerationSync, readEmployeeRuntimeBindingSync } from "./employee-bindings.ts";
import { buildTaskExecutionEventContext, recordTaskExecutionEventSync } from "./task-execution-events.ts";
import {
  chooseProviderSessionForTaskSync,
  createAgentRouterContextSnapshotSync,
  createAgentTaskAttemptSync,
  markAgentRouterProviderSessionInvalidSync,
  readLatestAgentTaskAttemptForTaskSync,
  recordAgentRouterEventSync,
  resolveRouterSessionForTaskSync,
  updateAgentTaskAttemptSync,
  upsertAgentRouterProviderSessionSync,
} from "./agent-router-sessions.ts";
import { readAgentRuntimeSync } from "./daemons.ts";
import { deleteMcpTaskSessionGrantSync } from "./mcp-session-grant.ts";
import { readTaskCommitJournalSync, upsertTaskCommitJournalSync } from "./task-commit-journal.ts";

export function enqueueNativeTaskSync(input: EnqueueTaskInput): QueuedTaskRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const binding = readEmployeeRuntimeBindingSync(input.assignee, workspaceId);
  if (!binding) {
    return null;
  }

  const now = new Date().toISOString();
  const queueId = `queue-${randomLikeId()}`;
  const payload = {
    taskId: input.taskId,
    assignee: input.assignee,
    title: input.title,
    channel: input.channel,
    priority: input.priority,
    ...(input.metadata ?? {}),
    requester:
      input.requestedByUserId || input.requestedByDisplayName
        ? {
            userId: input.requestedByUserId,
            displayName: input.requestedByDisplayName,
          }
        : undefined,
  };
  const routerSession = resolveRouterSessionForTaskSync({
    id: queueId,
    workspaceId,
    agentId: binding.employeeId,
    triggerType: input.triggerType ?? "manual",
    inputJson: JSON.stringify(payload),
    issueId: input.taskId,
  });

  db.prepare(
    `INSERT INTO agent_task_queue (
      id,
      workspace_id,
      agent_id,
      employee_id,
      employee_name,
      runtime_id,
      router_session_id,
      issue_id,
      trigger_type,
      priority,
      status,
      input_json,
      requested_by_user_id,
      requested_by_display_name,
      queued_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  ).run(
    queueId,
    workspaceId,
    input.assignee,
    binding.employeeId,
    binding.employeeName,
    binding.runtimeId,
    routerSession.id,
    input.taskId ?? null,
    input.triggerType ?? "manual",
    priorityToNumber(input.priority),
    JSON.stringify(payload),
    input.requestedByUserId ?? null,
    input.requestedByDisplayName ?? null,
    now,
    now,
    now,
  );

  const task = readQueuedTaskSync(queueId);
  if (task) {
    recordRouterLifecycleEvent(task, {
      type: "task_queued",
      actorType: "system",
      summary: input.title,
      data: {
        priority: input.priority,
        preferredRuntimeId: binding.runtimeId,
        requestedByUserId: input.requestedByUserId,
        requestedByDisplayName: input.requestedByDisplayName,
      },
    });
    recordQueueLifecycleEvent(task, {
      type: "queued",
      title: "Task entered the execution queue",
      summary: `${input.title} is waiting for ${binding.runtimeName}.`,
      status: "pending",
      data: {
        priority: input.priority,
        requestedByUserId: input.requestedByUserId,
        requestedByDisplayName: input.requestedByDisplayName,
      },
    });
  }

  return task;
}

export function listQueuedTasksSync(options?: {
  workspaceId?: string;
  runtimeId?: string;
}): QueuedTaskRecord[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: string[] = [];
  if (typeof options?.workspaceId === "string") {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (typeof options?.runtimeId === "string") {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        COALESCE(employee_id, agent_id) AS employeeId,
        COALESCE(employee_name, agent_id) AS employeeName,
        agent_id AS agentId,
        runtime_id AS runtimeId,
        router_session_id AS routerSessionId,
        issue_id AS issueId,
        trigger_type AS triggerType,
        priority,
        status,
        input_json AS inputJson,
        requested_by_user_id AS requestedByUserId,
        requested_by_display_name AS requestedByDisplayName,
        result_json AS resultJson,
        error_text AS errorText,
        session_id AS sessionId,
        work_dir AS workDir,
        binding_generation AS bindingGeneration,
        queued_at AS queuedAt,
        claimed_at AS claimedAt,
        started_at AS startedAt,
        finished_at AS finishedAt,
        mcp_session_claimed_at AS mcpSessionClaimedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_task_queue
      ${whereClause}
      ORDER BY created_at ASC`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapQueuedTaskRecord(row))
    .filter((row): row is QueuedTaskRecord => row !== null);
}

export function readLatestChannelExecutionSync(
  agentId: string,
  channelName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): QueuedTaskRecord | null {
  return readLatestConversationExecutionSync(agentId, { channelName }, workspaceId);
}

export function readLatestConversationExecutionSync(
  agentId: string,
  input: {
    channelName?: string;
    contactId?: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): QueuedTaskRecord | null {
  const employeeId = readEmployeeRuntimeBindingSync(agentId, workspaceId)?.employeeId ?? agentId;
  return (
    listQueuedTasksSync({ workspaceId })
      .filter((task) => task.employeeId === employeeId || task.agentId === agentId)
      .filter((task) => {
        try {
          const payload = JSON.parse(task.inputJson) as Record<string, unknown>;
          const matchesChannel =
            typeof input.channelName === "string" &&
            typeof payload.channelName === "string" &&
            payload.channelName === input.channelName;
          const matchesLegacyContact =
            typeof input.contactId === "string" &&
            typeof payload.contactId === "string" &&
            payload.contactId === input.contactId;

          return matchesChannel || matchesLegacyContact;
        } catch {
          return false;
        }
      })
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null
  );
}

export function readQueuedTaskSync(taskId: string): QueuedTaskRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        COALESCE(employee_id, agent_id) AS employeeId,
        COALESCE(employee_name, agent_id) AS employeeName,
        agent_id AS agentId,
        runtime_id AS runtimeId,
        router_session_id AS routerSessionId,
        issue_id AS issueId,
        trigger_type AS triggerType,
        priority,
        status,
        input_json AS inputJson,
        requested_by_user_id AS requestedByUserId,
        requested_by_display_name AS requestedByDisplayName,
        result_json AS resultJson,
        error_text AS errorText,
        session_id AS sessionId,
        work_dir AS workDir,
        binding_generation AS bindingGeneration,
        queued_at AS queuedAt,
        claimed_at AS claimedAt,
        started_at AS startedAt,
        finished_at AS finishedAt,
        mcp_session_claimed_at AS mcpSessionClaimedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_task_queue
      WHERE id = ?`,
    )
    .get(taskId) as Record<string, unknown> | undefined;

  return row ? mapQueuedTaskRecord(row) : null;
}

/**
 * Atomically marks an MCP task session as claimed. Returns `true` only when this
 * call was the first successful claim; subsequent calls (including concurrent
 * ones) return `false`. This makes `claimMcpTaskSessionSync` one-time per task.
 */
export function claimMcpTaskSessionMarkerSync(taskId: string): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE agent_task_queue
       SET mcp_session_claimed_at = ?,
           updated_at = ?
       WHERE id = ? AND mcp_session_claimed_at IS NULL`,
    )
    .run(now, now, taskId);
  return result.changes > 0;
}

export function readMcpTaskSessionClaimedSync(taskId: string): string | null {
  const task = readQueuedTaskSync(taskId);
  return task?.mcpSessionClaimedAt ?? null;
}

export function readTaskSkillExecutionSnapshotSync(taskId: string): TaskSkillExecutionSnapshot | null {
  // Select the raw snake_case column (no `AS camelCase` alias): Postgres
  // lowercases unquoted aliases, and NORMALIZED_ROW_KEY_ALIASES has no entry for
  // the lowered form, so an alias would read back as undefined. The underscore
  // key is converted to `skillExecutionSnapshotJson` by normalizeRowKey.
  const row = getDatabase().prepare(
    `SELECT skill_execution_snapshot_json
     FROM agent_task_queue WHERE id = ?`,
  ).get(taskId) as { skillExecutionSnapshotJson: string | null } | undefined;
  const raw = row?.skillExecutionSnapshotJson;
  if (!raw) {
    return null;
  }
  return parseTaskSkillExecutionSnapshotJson(raw);
}

export function writeTaskSkillExecutionSnapshotSync(taskId: string, snapshot: TaskSkillExecutionSnapshot): boolean {
  const now = new Date().toISOString();
  // First-write-wins: only the first preparation may persist the snapshot.
  // `AND ... IS NULL` makes a concurrent duplicate preparation a no-op instead
  // of silently overwriting the resolved snapshot.
  const result = getDatabase().prepare(
    `UPDATE agent_task_queue
     SET skill_execution_snapshot_json = ?, updated_at = ?
     WHERE id = ? AND skill_execution_snapshot_json IS NULL`,
  ).run(JSON.stringify(snapshot), now, taskId);
  return result.changes > 0;
}

export function claimNextQueuedTaskForRuntimeSync(runtimeId: string, workspaceId?: string): QueuedTaskRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  let claimedId: string | null = null;

  db.exec("BEGIN");
  try {
    const row = selectQueuedTaskForRuntime(db, runtimeId, workspaceId);

    if (row && typeof row.id === "string") {
      const employeeId = typeof row.employeeId === "string" ? row.employeeId : "";
      const taskWorkspaceId = typeof row.workspaceId === "string" ? row.workspaceId : (workspaceId ?? DEFAULT_WORKSPACE_ID);
      const bindingGeneration = employeeId ? readEmployeeBindingGenerationSync(employeeId, taskWorkspaceId) : undefined;
      db.prepare(
        `UPDATE agent_task_queue
         SET status = 'claimed',
             claimed_at = ?,
             binding_generation = ?,
             updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(now, bindingGeneration ?? null, now, row.id);
      claimedId = row.id;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const task = claimedId ? readQueuedTaskSync(claimedId) : null;
  if (task) {
    const runtime = readAgentRuntimeSync(task.runtimeId);
    const providerSession = chooseProviderSessionForTaskSync({ task });
    const attempt = runtime && task.routerSessionId
      ? createAgentTaskAttemptSync({
          workspaceId: task.workspaceId,
          taskQueueId: task.id,
          routerSessionId: task.routerSessionId,
          runtimeId: task.runtimeId,
          provider: runtime.provider,
          providerSessionId: providerSession?.providerSessionId,
          status: "claimed",
          metadata: {
            routingMode: providerSession ? "same_provider_resume" : "cold_rebuild",
          },
        })
      : null;
    recordRouterLifecycleEvent(task, {
      attemptId: attempt?.id,
      type: "runtime_selected",
      actorType: "system",
      runtimeId: task.runtimeId,
      provider: runtime?.provider,
      summary: `Task was assigned to runtime ${task.runtimeId}.`,
      data: {
        attemptId: attempt?.id,
        providerSessionId: providerSession?.providerSessionId,
        routingMode: providerSession ? "same_provider_resume" : "cold_rebuild",
      },
    });
    recordQueueLifecycleEvent(task, {
      type: "assigned",
      title: "Runtime claimed the task",
      summary: `${task.agentId} is assigned to runtime ${task.runtimeId}.`,
      status: "running",
      data: {
        claimedAt: task.claimedAt,
        attemptId: attempt?.id,
        routingMode: providerSession ? "same_provider_resume" : "cold_rebuild",
        providerSessionId: providerSession?.providerSessionId,
      },
    });
  }
  return task;
}

export function startQueuedTaskSync(taskId: string): QueuedTaskRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = readQueuedTaskSync(taskId);
  db.prepare(
    `UPDATE agent_task_queue
     SET status = 'running',
         started_at = COALESCE(started_at, ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(now, now, taskId);

  const task = readQueuedTaskSync(taskId);
  if (!task) {
    throw new Error(`Queued task "${taskId}" does not exist.`);
  }
  if (previous?.status !== "running") {
    const attempt = readLatestAgentTaskAttemptForTaskSync(task.id);
    if (attempt && attempt.status !== "running") {
      updateAgentTaskAttemptSync({ attemptId: attempt.id, status: "running" });
    }
    const runtime = readAgentRuntimeSync(task.runtimeId);
    recordRouterLifecycleEvent(task, {
      attemptId: attempt?.id,
      type: "provider_started",
      actorType: "runtime",
      actorId: task.runtimeId,
      runtimeId: task.runtimeId,
      provider: runtime?.provider,
      summary: `Runtime ${task.runtimeId} started execution.`,
      data: {
        attemptId: attempt?.id,
        providerSessionId: attempt?.providerSessionId,
      },
    });
    recordQueueLifecycleEvent(task, {
      type: "workspace_prepared",
      title: "Execution started",
      summary: `Runtime ${task.runtimeId} started the task.`,
      status: "running",
      data: { startedAt: task.startedAt },
    });
  }
  return task;
}

export function completeQueuedTaskSync(input: {
  taskId: string;
  resultJson?: Record<string, unknown>;
  sessionId?: string;
  workDir?: string;
}): QueuedTaskRecord {
  return completeQueuedTaskInternalSync(input, { viaCommitJournal: false });
}

/**
 * Durability-aware completion: only transitions a task to `completed` when it
 * has already reached `committed` (EAD §7). This is the completion entry point
 * for the new prepare→commit→complete flow so an uncommitted result can never
 * be reported as successful to the user.
 */
export function completeCommittedTaskSync(input: {
  taskId: string;
  resultJson?: Record<string, unknown>;
  sessionId?: string;
  workDir?: string;
}): QueuedTaskRecord {
  return completeQueuedTaskInternalSync(input, { viaCommitJournal: false, requireCommitted: true });
}

/**
 * Phase 1 of the durability commit split (EAD §7): running → preparing_commit.
 * Signals that the provider has finished and outputs are about to be promoted
 * to the persistent workspace. Idempotent if already preparing_commit.
 */
export function markTaskPreparingCommitSync(taskId: string): QueuedTaskRecord {
  const db = getDatabase();
  const previous = readQueuedTaskSync(taskId);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_task_queue SET status = 'preparing_commit', updated_at = ?
     WHERE id = ? AND status IN ('running', 'preparing_commit')`,
  ).run(now, taskId);
  const task = readQueuedTaskSync(taskId);
  if (!task) {
    throw new Error(`Queued task "${taskId}" does not exist.`);
  }
  if (previous && previous.status !== "preparing_commit" && task.status === "preparing_commit") {
    recordQueueLifecycleEvent(task, {
      type: "commit_preparing",
      title: "Preparing commit",
      summary: "Promoting task outputs to the persistent workspace before completion.",
      status: "running",
    });
  }
  return task;
}

/**
 * Phase 2 of the durability commit split: preparing_commit → committed, with a
 * task_commit_journal row recording the workspace revision + published artifacts.
 * The journal row is the durable "data has been persisted" marker; only after it
 * exists may a task be reported as successful to the user (EAD §7).
 */
export function markTaskCommittedSync(input: {
  taskId: string;
  employeeName?: string;
  workspaceRevisionId?: string;
  artifactIds?: string[];
}): QueuedTaskRecord {
  const db = getDatabase();
  const previous = readQueuedTaskSync(input.taskId);
  const now = new Date().toISOString();
  const task = withTransaction(db, () => {
    db.prepare(
      `UPDATE agent_task_queue SET status = 'committed', updated_at = ?
       WHERE id = ? AND status IN ('preparing_commit', 'committed', 'running')`,
    ).run(now, input.taskId);
    const current = readQueuedTaskSync(input.taskId);
    if (!current) {
      throw new Error(`Queued task "${input.taskId}" does not exist.`);
    }
    upsertTaskCommitJournalSync({
      taskId: current.id,
      workspaceId: current.workspaceId,
      employeeName: input.employeeName,
      workspaceRevisionId: input.workspaceRevisionId,
      artifactIdsJson: JSON.stringify(input.artifactIds ?? []),
      commitState: "committed",
    });
    deleteMcpTaskSessionGrantSync(current.id, current.workspaceId);
    return current;
  });
  if (previous && previous.status !== "committed" && task.status === "committed") {
    recordQueueLifecycleEvent(task, {
      type: "commit_committed",
      title: "Outputs committed",
      summary: "Task results were atomically committed to the persistent workspace.",
      status: "succeeded",
      data: {
        workspaceRevisionId: input.workspaceRevisionId,
        artifactCount: input.artifactIds?.length ?? 0,
      },
    });
  }
  return task;
}

function completeQueuedTaskInternalSync(
  input: {
    taskId: string;
    resultJson?: Record<string, unknown>;
    sessionId?: string;
    workDir?: string;
  },
  options: { viaCommitJournal: boolean; requireCommitted?: boolean },
): QueuedTaskRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = readQueuedTaskSync(input.taskId);
  if (options.requireCommitted && previous?.status !== "committed") {
    throw new Error(
      `Task "${input.taskId}" cannot be completed while status is "${previous?.status ?? "missing"}"; ` +
        "it must be committed first (EAD §7).",
    );
  }
  const task = withTransaction(db, () => {
    db.prepare(
      `UPDATE agent_task_queue
       SET status = 'completed',
           result_json = ?,
           session_id = ?,
           work_dir = ?,
           finished_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.resultJson ? JSON.stringify(input.resultJson) : null,
      input.sessionId ?? null,
      input.workDir ?? null,
      now,
      now,
      input.taskId,
    );
    const current = readQueuedTaskSync(input.taskId);
    if (!current) {
      throw new Error(`Queued task "${input.taskId}" does not exist.`);
    }
    deleteMcpTaskSessionGrantSync(current.id, current.workspaceId);
    return current;
  });
  if (previous?.status !== "completed") {
    const attempt = readLatestAgentTaskAttemptForTaskSync(task.id);
    const runtime = readAgentRuntimeSync(task.runtimeId);
    if (attempt) {
      updateAgentTaskAttemptSync({
        attemptId: attempt.id,
        status: "completed",
        providerSessionId: input.sessionId ?? null,
        metadata: mergeJsonObject(attempt.metadataJson, {
          workDir: input.workDir,
          completedAt: task.finishedAt,
          resumeMode: attempt.providerSessionId ? "same_provider_resume" : "cold_rebuild",
        }),
      });
    }
    if (runtime && task.routerSessionId && input.sessionId) {
      upsertAgentRouterProviderSessionSync({
        workspaceId: task.workspaceId,
        routerSessionId: task.routerSessionId,
        runtimeId: task.runtimeId,
        provider: runtime.provider,
        providerSessionId: input.sessionId,
        metadata: {
          taskQueueId: task.id,
          attemptId: attempt?.id,
          workDir: input.workDir,
        },
      });
    }
    recordRouterLifecycleEvent(task, {
      attemptId: attempt?.id,
      type: "final_answer",
      actorType: "agent",
      actorId: task.employeeId,
      runtimeId: task.runtimeId,
      provider: runtime?.provider,
      summary: readResultSummary(input.resultJson),
      data: {
        attemptId: attempt?.id,
        providerSessionId: input.sessionId,
        workDir: input.workDir,
      },
    });
    recordArtifactEvents(task, input.resultJson);
    recordQueueLifecycleEvent(task, {
      type: "completed",
      title: "Task completed",
      summary: "The agent returned a final result and the task is closed.",
      status: "succeeded",
      data: {
        finishedAt: task.finishedAt,
        sessionId: input.sessionId,
        workDir: input.workDir,
      },
    });
    // Backward compatibility: callers that did not drive the explicit
    // prepare→commit phases still get a committed journal row so every
    // completed task has a durable "data persisted" marker. Explicit callers
    // (markTaskCommittedSync) already wrote one; don't bump their attempt count.
    if (!options.viaCommitJournal && !readTaskCommitJournalSync(task.id, task.workspaceId)) {
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        commitState: "committed",
        artifactIdsJson: "[]",
      });
    }
  }
  return task;
}

export function failQueuedTaskSync(input: {
  taskId: string;
  errorText: string;
  sessionId?: string;
  workDir?: string;
  errorCode?: string;
  errorCategory?: string;
  provider?: string;
  rawProviderMessage?: string;
}): QueuedTaskRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = readQueuedTaskSync(input.taskId);
  const task = withTransaction(db, () => {
    db.prepare(
      `UPDATE agent_task_queue
       SET status = 'failed',
           error_text = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           finished_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(input.errorText, input.sessionId ?? null, input.workDir ?? null, now, now, input.taskId);
    const current = readQueuedTaskSync(input.taskId);
    if (!current) {
      throw new Error(`Queued task "${input.taskId}" does not exist.`);
    }
    deleteMcpTaskSessionGrantSync(current.id, current.workspaceId);
    return current;
  });
  if (previous?.status !== "failed") {
    const blocked = isBlockedFailure(input);
    const attempt = readLatestAgentTaskAttemptForTaskSync(task.id);
    const runtime = readAgentRuntimeSync(task.runtimeId);
    const handoffSnapshot = task.routerSessionId
      ? createAgentRouterContextSnapshotSync({
          workspaceId: task.workspaceId,
          routerSessionId: task.routerSessionId,
          taskQueueId: task.id,
          snapshotType: "handoff",
          contentMarkdown: buildFailureHandoffSnapshot(task, input),
        })
      : null;
    if (attempt) {
      updateAgentTaskAttemptSync({
        attemptId: attempt.id,
        status: "failed",
        providerSessionId: input.sessionId ?? null,
        errorText: input.errorText,
        handoffSnapshotId: handoffSnapshot?.id ?? null,
        metadata: mergeJsonObject(attempt.metadataJson, {
          workDir: input.workDir,
          errorCode: input.errorCode,
          errorCategory: input.errorCategory,
          provider: input.provider,
          failedAt: task.finishedAt,
        }),
      });
    }
    if (task.routerSessionId && isProviderSessionInvalidFailure(input)) {
      markAgentRouterProviderSessionInvalidSync({
        workspaceId: task.workspaceId,
        routerSessionId: task.routerSessionId,
        runtimeId: task.runtimeId,
        provider: runtime?.provider,
        providerSessionId: input.sessionId,
        lastError: input.errorText,
      });
    } else if (runtime && task.routerSessionId && input.sessionId) {
      upsertAgentRouterProviderSessionSync({
        workspaceId: task.workspaceId,
        routerSessionId: task.routerSessionId,
        runtimeId: task.runtimeId,
        provider: runtime.provider,
        providerSessionId: input.sessionId,
        status: "active",
        lastError: input.errorText,
        metadata: {
          taskQueueId: task.id,
          attemptId: attempt?.id,
          workDir: input.workDir,
          failure: true,
        },
      });
    }
    recordRouterLifecycleEvent(task, {
      attemptId: attempt?.id,
      type: "failure",
      actorType: "runtime",
      actorId: task.runtimeId,
      runtimeId: task.runtimeId,
      provider: runtime?.provider ?? readDaemonProvider(input.provider),
      summary: truncateSummary(input.errorText),
      data: {
        attemptId: attempt?.id,
        handoffSnapshotId: handoffSnapshot?.id,
        providerSessionId: input.sessionId,
        providerSessionInvalid: isProviderSessionInvalidFailure(input),
        errorCode: input.errorCode,
        errorCategory: input.errorCategory,
        rawProviderMessage: truncateSummary(input.rawProviderMessage),
        workDir: input.workDir,
      },
    });
    if (handoffSnapshot) {
      recordRouterLifecycleEvent(task, {
        attemptId: attempt?.id,
        type: "handoff_snapshot_created",
        actorType: "system",
        runtimeId: task.runtimeId,
        provider: runtime?.provider ?? readDaemonProvider(input.provider),
        summary: "A handoff snapshot was captured from the failed task attempt.",
        data: {
          handoffSnapshotId: handoffSnapshot.id,
          attemptId: attempt?.id,
        },
      });
    }
    recordQueueLifecycleEvent(task, {
      type: blocked ? "blocked" : "failed",
      title: blocked ? "Task is blocked" : "Task failed",
      summary: truncateSummary(input.errorText),
      severity: "error",
      status: "failed",
      data: {
        errorCode: input.errorCode,
        errorCategory: input.errorCategory,
        provider: input.provider,
        rawProviderMessage: truncateSummary(input.rawProviderMessage),
        sessionId: input.sessionId,
        workDir: input.workDir,
      },
    });
  }
  return task;
}

export function cancelQueuedTaskSync(input: {
  taskId: string;
  errorText?: string;
}): QueuedTaskRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = readQueuedTaskSync(input.taskId);
  const task = withTransaction(db, () => {
    db.prepare(
      `UPDATE agent_task_queue
       SET status = 'cancelled',
           error_text = COALESCE(?, error_text),
           finished_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('queued', 'claimed', 'running')`,
    ).run(input.errorText ?? null, now, now, input.taskId);
    const current = readQueuedTaskSync(input.taskId);
    if (!current) {
      throw new Error(`Queued task "${input.taskId}" does not exist.`);
    }
    if (current.status === "cancelled") {
      deleteMcpTaskSessionGrantSync(current.id, current.workspaceId);
    }
    return current;
  });
  if (previous?.status !== "cancelled" && task.status === "cancelled") {
    const wasRunning = previous?.status === "claimed" || previous?.status === "running";
    const attempt = readLatestAgentTaskAttemptForTaskSync(task.id);
    if (attempt) {
      updateAgentTaskAttemptSync({
        attemptId: attempt.id,
        status: "cancelled",
        errorText: input.errorText ?? "Task cancelled.",
      });
    }
    const runtime = readAgentRuntimeSync(task.runtimeId);
    recordRouterLifecycleEvent(task, {
      attemptId: attempt?.id,
      type: "cancelled",
      actorType: "system",
      runtimeId: task.runtimeId,
      provider: runtime?.provider,
      summary: input.errorText
        ? truncateSummary(input.errorText)
        : wasRunning
          ? "Task execution was stopped."
          : "Task cancelled before execution.",
      data: {
        attemptId: attempt?.id,
      },
    });
    recordQueueLifecycleEvent(task, {
      type: "cancelled",
      title: "Task cancelled",
      summary: input.errorText
        ? truncateSummary(input.errorText)
        : wasRunning
          ? "The running task was stopped."
          : "The queued task was cancelled before execution.",
      severity: input.errorText ? "warning" : "info",
      status: "failed",
    });
  }
  return task;
}

function recordQueueLifecycleEvent(
  task: QueuedTaskRecord,
  event: {
    type: Parameters<typeof recordTaskExecutionEventSync>[0]["type"];
    title: string;
    summary?: string;
    severity?: Parameters<typeof recordTaskExecutionEventSync>[0]["severity"];
    status?: Parameters<typeof recordTaskExecutionEventSync>[0]["status"];
    data?: Record<string, unknown>;
  },
): void {
  const context = buildTaskExecutionEventContext(task);
  recordTaskExecutionEventSync({
    ...context,
    type: event.type,
    title: event.title,
    summary: event.summary,
    severity: event.severity,
    status: event.status,
    data: {
      triggerType: context.triggerType,
      issueId: context.issueId,
      taskTitle: context.taskTitle,
      ...event.data,
    },
  });
}

function recordRouterLifecycleEvent(
  task: QueuedTaskRecord,
  event: {
    type: string;
    actorType: Parameters<typeof recordAgentRouterEventSync>[0]["actorType"];
    actorId?: string;
    attemptId?: string;
    runtimeId?: string;
    provider?: Parameters<typeof recordAgentRouterEventSync>[0]["provider"];
    summary?: string;
    data?: Record<string, unknown>;
  },
): void {
  if (!task.routerSessionId) {
    return;
  }
  recordAgentRouterEventSync({
    workspaceId: task.workspaceId,
    routerSessionId: task.routerSessionId,
    taskQueueId: task.id,
    attemptId: event.attemptId,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    runtimeId: event.runtimeId ?? task.runtimeId,
    provider: event.provider,
    summary: event.summary,
    data: event.data,
  });
}

function recordArtifactEvents(task: QueuedTaskRecord, resultJson: Record<string, unknown> | undefined): void {
  if (!resultJson) {
    return;
  }
  const attachments = readObjectArray(resultJson.attachments);
  const skillImports = readObjectArray(resultJson.skillImports);
  const documentUpdates = readObjectArray(resultJson.documentUpdates);
  const knowledgeProposals = readObjectArray(resultJson.knowledgeProposals);
  const artifactCount = attachments.length + skillImports.length + documentUpdates.length + knowledgeProposals.length;
  if (artifactCount === 0) {
    return;
  }

  recordQueueLifecycleEvent(task, {
    type: "artifact_detected",
    title: "Runtime output contained artifacts",
    summary: `${artifactCount} runtime output artifact${artifactCount === 1 ? "" : "s"} will be collected.`,
    status: "running",
    data: {
      attachmentCount: attachments.length,
      skillImportCount: skillImports.length,
      documentUpdateCount: documentUpdates.length,
      knowledgeProposalCount: knowledgeProposals.length,
    },
  });

  for (const attachment of attachments) {
    const id = readString(attachment.id);
    const fileName = readString(attachment.fileName) ?? "attachment";
    recordQueueLifecycleEvent(task, {
      type: "artifact_collected",
      title: `Attachment collected: ${fileName}`,
      summary: "The artifact is available as a workspace attachment.",
      status: "succeeded",
      data: {
        artifactKind: "attachment",
        attachmentId: id,
        fileName,
        mediaType: readString(attachment.mediaType),
        sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : undefined,
        targetHref: id ? `/api/attachments/${encodeURIComponent(id)}` : undefined,
      },
    });
  }

  for (const documentUpdate of documentUpdates) {
    const documentId = readString(documentUpdate.documentId);
    recordQueueLifecycleEvent(task, {
      type: "artifact_collected",
      title: "Channel document updated",
      summary: "The runtime output was promoted into a channel document.",
      status: "succeeded",
      data: {
        artifactKind: "channel_document",
        documentId,
        documentVersionId: readString(documentUpdate.documentVersionId),
        targetHref: documentId ? `/im?tab=documents&doc=${encodeURIComponent(documentId)}` : undefined,
      },
    });
  }

  for (const skillImport of skillImports) {
    const skillName = readString(skillImport.skillName) ?? readString(skillImport.name) ?? "skill";
    recordQueueLifecycleEvent(task, {
      type: "artifact_collected",
      title: `Skill import collected: ${skillName}`,
      summary: "The runtime output was applied to the workspace skill library.",
      status: "succeeded",
      data: {
        artifactKind: "skill_import",
        skillName,
        skillId: readString(skillImport.skillId),
      },
    });
  }

  for (const proposal of knowledgeProposals) {
    const title = readString(proposal.title) ?? "Knowledge proposal";
    recordQueueLifecycleEvent(task, {
      type: "approval_requested",
      title: `Knowledge proposal collected: ${title}`,
      summary: readString(proposal.message) ?? "The runtime output submitted a workspace knowledge proposal for human approval.",
      status: readString(proposal.status) === "failed" ? "failed" : "pending",
      severity: readString(proposal.status) === "failed" ? "error" : "warning",
      data: {
        artifactKind: "knowledge_proposal",
        proposalId: readString(proposal.proposalId),
        approvalId: readString(proposal.approvalId),
        operation: readString(proposal.operation),
        status: readString(proposal.status),
      },
    });
  }
}

function selectQueuedTaskForRuntime(
  db: ReturnType<typeof getDatabase>,
  runtimeId: string,
  workspaceId?: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT queue.id, COALESCE(queue.employee_id, queue.agent_id) AS employeeId,
              queue.agent_id AS agentId, queue.workspace_id AS workspaceId
       FROM agent_task_queue queue
       JOIN agent_runtime runtime ON runtime.id = queue.runtime_id
       JOIN employee_runtime_binding binding
         ON binding.workspace_id = queue.workspace_id
         AND (
           binding.employee_id = queue.employee_id
           OR (queue.employee_id IS NULL AND (binding.employee_id = queue.agent_id OR binding.employee_name = queue.agent_id))
         )
         AND binding.runtime_id = queue.runtime_id
       WHERE queue.runtime_id = ? AND queue.status = 'queued'
         AND (runtime.managed_credential_id IS NULL OR runtime.provisioning_state = 'managed')
       ${typeof workspaceId === "string" ? "AND queue.workspace_id = ?" : ""}
       ORDER BY queue.priority DESC, queue.created_at ASC
       LIMIT 1`,
    )
    .get(...(typeof workspaceId === "string" ? [runtimeId, workspaceId] : [runtimeId])) as Record<string, unknown> | undefined;
}


function isBlockedFailure(input: {
  errorText: string;
  errorCode?: string;
  errorCategory?: string;
}): boolean {
  const value = `${input.errorCode ?? ""} ${input.errorCategory ?? ""} ${input.errorText}`.toLowerCase();
  return /\b(auth|permission|denied|forbidden|credential|budget|quota|approval|profile|context|blocked|unauthorized)\b/.test(value);
}

function isProviderSessionInvalidFailure(input: {
  errorText: string;
  errorCode?: string;
  errorCategory?: string;
}): boolean {
  return input.errorCode === "provider.session_invalid" ||
    /\b(session invalid|invalid session|session.*not found|no conversation found|no rollout found|harness\.session_missing)\b/i.test(input.errorText);
}

function buildFailureHandoffSnapshot(
  task: QueuedTaskRecord,
  input: {
    errorText: string;
    sessionId?: string;
    workDir?: string;
    errorCode?: string;
    errorCategory?: string;
    provider?: string;
    rawProviderMessage?: string;
  },
): string {
  const payload = safeParseJsonObject(task.inputJson);
  const lines = [
    "# Handoff Snapshot",
    "",
    `Task queue id: ${task.id}`,
    `Agent: ${task.agentId}`,
    `Runtime: ${task.runtimeId}`,
    input.provider ? `Provider: ${input.provider}` : "",
    input.sessionId ? `Provider session at failure: ${input.sessionId}` : "",
    input.workDir ? `Runtime-local workDir: ${input.workDir}` : "",
    "",
    "## Current Task Goal",
    readString(payload.title) ?? readString(payload.channelMessage) ?? task.issueId ?? task.id,
    "",
    "## Failure",
    input.errorCode ? `Error code: ${input.errorCode}` : "",
    input.errorCategory ? `Error category: ${input.errorCategory}` : "",
    summarizeFailureForHandoff(input.errorText) ?? "Provider execution failed.",
    "",
    "## Continuation Guidance",
    "- Treat provider hidden state, provider session id, credentials, and runtime-local workDir as non-portable unless the next attempt is on the same runtime and provider.",
    "- Rebuild context from DofeAgent messages, router events, knowledge, documents, attachments, and formal output records.",
    "- Continue from the task goal above and explicitly call out any missing runtime-local artifact if it was not promoted to formal storage.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function readResultSummary(resultJson: Record<string, unknown> | undefined): string | undefined {
  if (!resultJson) {
    return undefined;
  }
  return truncateSummary(readString(resultJson.output) ?? readString(resultJson.summary));
}

function mergeJsonObject(json: string, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    ...safeParseJsonObject(json),
    ...dropUndefined(patch),
  };
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function safeParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Parses the persisted task skill-execution snapshot JSON, tolerating corrupt rows. */
function parseTaskSkillExecutionSnapshotJson(raw: string): TaskSkillExecutionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.resolvedAt !== "string" ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const entries: TaskSkillExecutionSnapshotEntry[] = [];
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.skillId !== "string" ||
      typeof item.skillName !== "string" ||
      typeof item.artifactDigest !== "string" ||
      typeof item.installationId !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.status !== "string"
    ) {
      continue;
    }
    entries.push({
      skillId: item.skillId,
      skillName: item.skillName,
      artifactDigest: item.artifactDigest,
      installationId: item.installationId,
      revision: item.revision,
      status: item.status,
      ...(typeof item.releaseLockDigest === "string" ? { releaseLockDigest: item.releaseLockDigest } : {}),
      ...(typeof item.dependencyEnvironmentRequired === "boolean"
        ? { dependencyEnvironmentRequired: item.dependencyEnvironmentRequired }
        : {}),
    });
  }
  return {
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    resolvedAt: value.resolvedAt,
    entries,
  };
}

function readStringFromTaskInput(inputJson: string, key: string): string | undefined {
  return readString(safeParseJsonObject(inputJson)[key]);
}

function readObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readDaemonProvider(value: unknown): DaemonProvider | undefined {
  return typeof value === "string" && isDaemonProvider(value) ? value : undefined;
}

function truncateSummary(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

function summarizeFailureForHandoff(value: unknown): string | undefined {
  const summary = truncateSummary(value);
  if (!summary) {
    return undefined;
  }
  const diagnosticStart = summary.search(/\b(?:rawProviderMessage|stderrTail)\s*=/i);
  if (diagnosticStart < 0) {
    return summary;
  }
  return summary.slice(0, diagnosticStart).replace(/[\s(;,:-]+$/, "").trim() || undefined;
}

function mapQueuedTaskRecord(value: Record<string, unknown>): QueuedTaskRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.triggerType !== "string" ||
    typeof value.priority !== "number" ||
    !isNativeTaskStatus(value.status) ||
    typeof value.inputJson !== "string" ||
    typeof value.queuedAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    agentId: value.agentId,
    runtimeId: value.runtimeId,
    routerSessionId: typeof value.routerSessionId === "string" ? value.routerSessionId : undefined,
    issueId: typeof value.issueId === "string" ? value.issueId : undefined,
    triggerType: value.triggerType,
    priority: value.priority,
    status: value.status,
    inputJson: value.inputJson,
    requestedByUserId: typeof value.requestedByUserId === "string" ? value.requestedByUserId : undefined,
    requestedByDisplayName: typeof value.requestedByDisplayName === "string" ? value.requestedByDisplayName : undefined,
    resultJson: typeof value.resultJson === "string" ? value.resultJson : undefined,
    errorText: typeof value.errorText === "string" ? value.errorText : undefined,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    workDir: typeof value.workDir === "string" ? value.workDir : undefined,
    queuedAt: value.queuedAt,
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    mcpSessionClaimedAt: typeof value.mcpSessionClaimedAt === "string" ? value.mcpSessionClaimedAt : undefined,
    bindingGeneration: typeof value.bindingGeneration === "number" ? value.bindingGeneration : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
