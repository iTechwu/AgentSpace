import {
  failQueuedTaskSync,
  listStaleCommitJournalsSync,
  markTaskCommittedSync,
  readQueuedTaskSync,
  upsertTaskCommitJournalSync,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import { promoteTaskOutputsToWorkspaceSync, type TaskOutputFile } from "./persistent-workspace.ts";

export interface CommitReconciliationDerivedOutputs {
  outputs: TaskOutputFile[];
  deletedPaths: string[];
}

/**
 * Derives the durable outputs for a task whose promotion failed mid-commit.
 * The web/daemon layer injects this (it has filesystem access to the task
 * output staging dir); services stays storage-agnostic and testable.
 * Returning null means the original outputs are unrecoverable.
 */
export type CommitReconciliationOutputDeriver = (
  task: QueuedTaskRecord,
) => CommitReconciliationDerivedOutputs | null;

export interface ReconcileCommitJournalsOptions {
  workspaceId?: string;
  /** Journals untouched for this many seconds are candidates. */
  staleBeforeSeconds?: number;
  limit?: number;
  /** Attempts before a stuck journal is rolled back as unrecoverable. */
  maxAttempts?: number;
  /** Output deriver; when absent, unrecoverable journals are rolled back. */
  deriveOutputs?: CommitReconciliationOutputDeriver;
}

export interface ReconcileCommitJournalsResult {
  committed: number;
  retried: number;
  rolledBack: number;
  skipped: number;
}

/**
 * Reconciles stale `preparing_commit` journals (P1-2): re-drives the durability
 * commit for tasks that received outputs but never reached `committed` because
 * the daemon disappeared after a 503. Each candidate:
 *   1. re-promotes the persisted outputs under the task's claim-time generation
 *      lease (a stale lease fails the promotion → journal stays preparing),
 *   2. marks the task committed on success,
 *   3. bumps the journal attempt on transient failure, and rolls the journal
 *      back (task failed) once attempts exceed `maxAttempts` — only when the
 *      outputs are unrecoverable or the lease is permanently stale.
 */
export function reconcileStaleCommitJournalsSync(
  options: ReconcileCommitJournalsOptions = {},
): ReconcileCommitJournalsResult {
  const staleBeforeSeconds = options.staleBeforeSeconds ?? 3600;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const journals = listStaleCommitJournalsSync({
    workspaceId: options.workspaceId,
    staleBeforeSeconds,
    limit: options.limit,
  });

  const result: ReconcileCommitJournalsResult = { committed: 0, retried: 0, rolledBack: 0, skipped: 0 };
  for (const journal of journals) {
    const task = readQueuedTaskSync(journal.taskId);
    if (!task) {
      // Task row gone — nothing to reconcile; record the journal as rolled back.
      rollbackJournal(journal, "Task no longer exists; nothing to commit.");
      result.rolledBack += 1;
      continue;
    }

    const derived = options.deriveOutputs?.(task);
    if (!derived) {
      // Original outputs are unrecoverable (staging cleared/expired). Roll back
      // only when attempts are exhausted; otherwise keep the journal for another
      // reconciliation round so a slow daemon can still deliver.
      if (journal.attempt >= maxAttempts) {
        rollbackJournal(journal, "Original task outputs are unrecoverable and retries are exhausted.");
        result.rolledBack += 1;
      } else {
        bumpJournalAttempt(journal, "Outputs not yet available; awaiting another reconciliation round.");
        result.retried += 1;
      }
      continue;
    }

    try {
      // Re-promote under the task's claim-time generation lease. If the employee
      // was rebound, the promotion throws STALE_BINDING_GENERATION and the task
      // must not commit into the new workspace.
      const promoted = promoteTaskOutputsToWorkspaceSync({
        workspaceId: task.workspaceId,
        taskId: task.id,
        employeeName: task.employeeName,
        outputs: derived.outputs,
        deletedPaths: derived.deletedPaths,
        publishArtifacts: true,
        expectedBindingGeneration: task.bindingGeneration,
      });
      markTaskCommittedSync({
        taskId: task.id,
        employeeName: task.employeeName,
        workspaceRevisionId: promoted.revision.id,
        artifactIds: promoted.artifactIds,
      });
      result.committed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (journal.attempt >= maxAttempts) {
        rollbackJournal(journal, `Promotion failed permanently after ${maxAttempts} attempts: ${message}`);
        result.rolledBack += 1;
      } else {
        bumpJournalAttempt(journal, message);
        result.retried += 1;
      }
    }
  }
  return result;
}

function bumpJournalAttempt(journal: { taskId: string; workspaceId: string }, message: string): void {
  upsertTaskCommitJournalSync({
    taskId: journal.taskId,
    workspaceId: journal.workspaceId,
    commitState: "preparing",
    errorCode: "commit_reconciliation_retrying",
    errorMessage: message,
  });
}

function rollbackJournal(journal: { taskId: string; workspaceId: string; employeeName?: string }, message: string): void {
  upsertTaskCommitJournalSync({
    taskId: journal.taskId,
    workspaceId: journal.workspaceId,
    employeeName: journal.employeeName,
    commitState: "rolled_back",
    errorCode: "commit_reconciliation_rolled_back",
    errorMessage: message,
  });
  // The task can never be committed by anyone; fail it so the queue backlog is
  // actionable instead of stuck in `preparing_commit` forever.
  try {
    failQueuedTaskSync({
      taskId: journal.taskId,
      errorText: message,
      errorCode: "task.commit_rolled_back",
    });
  } catch {
    // The task may already be in a terminal state; the journal is the record.
  }
}
