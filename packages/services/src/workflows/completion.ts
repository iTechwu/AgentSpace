import {
  appendWorkflowRunEventSync,
  getDatabase,
  lockWorkflowRunForUpdateSync,
  markTaskPreparingCommitSync,
  readQueuedTaskSync,
  readTaskCommitJournalSync,
  readWorkflowNodeRunByTaskQueueIdSync,
  readWorkflowRunSync,
  startQueuedTaskSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  upsertTaskCommitJournalSync,
  withTransaction,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import { completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";
import { workflowNodeOutputFields } from "./inputs.ts";
import { retryWorkflowNodeSync } from "./retries.ts";

const MAX_WORKFLOW_OUTPUT_BYTES = 256 * 1024;

export interface StartQueuedTaskWithWorkflowResult {
  task: QueuedTaskRecord;
  startedNow: boolean;
  ignored: boolean;
}

export function startQueuedTaskWithWorkflowSync(input: {
  workspaceId: string;
  taskQueueId: string;
}): StartQueuedTaskWithWorkflowResult {
  return withTransaction(getDatabase(), () => {
    const candidate = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    if (!candidate) {
      const before = readQueuedTaskSync(input.taskQueueId);
      if (!before) throw new Error(`Queued task "${input.taskQueueId}" does not exist.`);
      if (!["queued", "claimed", "running"].includes(before.status)) {
        return { task: before, startedNow: false, ignored: true };
      }
      const task = startQueuedTaskSync(input.taskQueueId);
      return { task, startedNow: before?.status !== "running" && task.status === "running", ignored: false };
    }
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    const currentTask = readQueuedTaskSync(input.taskQueueId);
    if (!nodeRun || !currentTask) throw new Error("workflow_task_queue_mismatch");
    if (["completed", "failed", "cancelled"].includes(currentTask.status)
      || ["succeeded", "failed", "skipped", "cancelled"].includes(nodeRun.status)) {
      return { task: currentTask, startedNow: false, ignored: true };
    }
    if (currentTask.status === "running" && nodeRun.status === "running") {
      return { task: currentTask, startedNow: false, ignored: false };
    }
    if (isWorkflowTaskStartBlocked(run.status, nodeRun.status, currentTask.status)) {
      throw new Error("workflow_run_not_startable");
    }
    const started = startQueuedTaskSync(input.taskQueueId);
    const now = started.startedAt ?? new Date().toISOString();
    const transitioned = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued"],
      to: "running",
      startedAt: now,
      now,
    });
    if (transitioned) {
      // Run 首次由 created/queued 进入 running 的真实启动路径：transitionWorkflowRunSync 在
      // 已是 running 时返回 null，因此 run.started 事实事件只会发出一次。
      const runStarted = transitionWorkflowRunSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        from: ["created", "queued"],
        to: "running",
        startedAt: now,
        now,
      });
      if (runStarted) {
        appendWorkflowRunEventSync({
          workspaceId: input.workspaceId,
          runId: run.id,
          type: "run.started",
          actorType: "daemon",
          now,
        });
      }
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        nodeRunId: transitioned.id,
        type: "node.started",
        actorType: "daemon",
        dataJson: JSON.stringify({ taskQueueId: input.taskQueueId }),
        now,
      });
    }
    return { task: started, startedNow: Boolean(transitioned), ignored: false };
  });
}

export function isWorkflowTaskStartBlocked(runStatus: string, nodeStatus: string, taskStatus: string): boolean {
  if (["cancelled", "failed", "succeeded", "partially_succeeded"].includes(runStatus)) return true;
  if (nodeStatus !== "queued") return true;
  // Pausing is a dispatch barrier. A task already claimed by a daemon is in
  // flight and may cross start so it cannot be stranded in `claimed` forever.
  return runStatus === "paused" && taskStatus !== "claimed";
}

export function lockWorkflowRunForTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  allowPreparingCommit?: boolean;
  allowCommitted?: boolean;
}): { linked: boolean; ignored: boolean; taskStatus?: string } {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  const run = nodeRun ? lockWorkflowRunForUpdateSync(nodeRun.runId, input.workspaceId) : null;
  if (nodeRun && !run) throw new Error("workflow_run_not_found");
  const currentTask = readQueuedTaskSync(input.taskQueueId);
  if (!currentTask) throw new Error(`Queued task "${input.taskQueueId}" does not exist.`);
  if (isWorkflowTaskCallbackIgnored(currentTask.status, {
    allowPreparingCommit: input.allowPreparingCommit === true,
    allowCommitted: input.allowCommitted === true,
  })) {
    return { linked: Boolean(nodeRun), ignored: true, taskStatus: currentTask.status };
  }
  if (!nodeRun) return { linked: false, ignored: false, taskStatus: currentTask.status };
  if (!run) throw new Error("workflow_run_not_found");
  const currentNode = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!currentNode) throw new Error("workflow_task_queue_mismatch");
  const ignored = ["succeeded", "failed", "skipped", "cancelled"].includes(currentNode.status)
    || ["cancelled", "failed", "succeeded", "partially_succeeded"].includes(run.status)
    || (run.status === "paused" && currentNode.status !== "running");
  return { linked: true, ignored, taskStatus: currentTask.status };
}

export function isWorkflowTaskCallbackIgnored(taskStatus: string, options: {
  allowPreparingCommit?: boolean;
  allowCommitted?: boolean;
} = {}): boolean {
  if (["cancelled", "failed", "completed"].includes(taskStatus)) return true;
  if (taskStatus === "preparing_commit") return options.allowPreparingCommit !== true;
  if (taskStatus === "committed") return options.allowCommitted !== true;
  return false;
}

export function beginWorkflowTaskCommitSync(input: {
  workspaceId: string;
  taskQueueId: string;
  completionEffectsCheckpointed?: boolean;
}): { ignored: boolean; taskStatus: string; resumed?: boolean } {
  const fence = lockWorkflowRunForTaskIfLinkedSync({ ...input, allowPreparingCommit: true });
  if (fence.ignored) return { ignored: true, taskStatus: fence.taskStatus ?? "cancelled" };
  if (fence.taskStatus === "preparing_commit") {
    const journal = readTaskCommitJournalSync(input.taskQueueId, input.workspaceId);
    if (!isWorkflowTaskCommitReplaySafe({
      journalState: journal?.commitState,
      journalErrorCode: journal?.errorCode,
      completionEffectsCheckpointed: input.completionEffectsCheckpointed === true,
    })) {
      return { ignored: true, taskStatus: fence.taskStatus };
    }
    return { ignored: false, taskStatus: fence.taskStatus, resumed: true };
  }
  const task = markTaskPreparingCommitSync(input.taskQueueId);
  upsertTaskCommitJournalSync({
    taskId: task.id,
    workspaceId: task.workspaceId,
    commitState: "preparing",
    errorCode: "workflow_completion_effects_pending",
  });
  return { ignored: false, taskStatus: task.status };
}

export function isWorkflowTaskCommitReplaySafe(input: {
  journalState?: string;
  journalErrorCode?: string;
  completionEffectsCheckpointed: boolean;
}): boolean {
  return input.journalState === "preparing" && (
    input.completionEffectsCheckpointed || [
      "workspace_promotion_failed",
      "workflow_completion_effects_checkpointed",
      "commit_reconciliation_retrying",
    ].includes(input.journalErrorCode ?? "")
  );
}

export function isWorkflowTaskInputAvailableSync(input: {
  workspaceId: string;
  taskQueueId: string;
}): boolean {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return true;
  const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
  const task = readQueuedTaskSync(input.taskQueueId);
  return Boolean(run && task && isWorkflowTaskInputAvailable(run.status, nodeRun.status, task.status));
}

export function isWorkflowTaskInputAvailable(
  runStatus: string,
  nodeStatus: string,
  taskStatus?: string,
): boolean {
  if (["cancelled", "failed", "succeeded", "partially_succeeded"].includes(runStatus)) return false;
  // A paused Run stops new dispatches, but work that crossed the claim/start
  // boundary remains active and must still be able to load its input bundle.
  return runStatus !== "paused" || nodeStatus === "running" || taskStatus === "claimed" || taskStatus === "running";
}

export function completeWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  outputText: string;
  structuredOutput?: Record<string, unknown>;
  normalizedOutput?: Record<string, unknown>;
  artifactManifest: unknown[];
}): { linked: boolean; runId?: string } {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return { linked: false };
  const run = completeWorkflowNodeSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    taskQueueId: input.taskQueueId,
    output: input.normalizedOutput ?? normalizeWorkflowNodeOutput({
        outputText: input.outputText,
        structuredOutput: input.structuredOutput,
        nodeConfigJson: nodeRun.inputJson,
      }),
    artifactManifest: input.artifactManifest,
  });
  return { linked: true, runId: run.id };
}

export function prepareWorkflowTaskOutputSync(input: {
  workspaceId: string;
  taskQueueId: string;
  outputText: string;
  structuredOutput?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return undefined;
  return normalizeWorkflowNodeOutput({
    outputText: input.outputText,
    structuredOutput: input.structuredOutput,
    nodeConfigJson: nodeRun.inputJson,
  });
}

export function normalizeWorkflowNodeOutput(input: {
  outputText: string;
  structuredOutput?: Record<string, unknown>;
  nodeConfigJson: string;
}): Record<string, unknown> {
  const config = parseRecord(input.nodeConfigJson);
  const fields = workflowNodeOutputFields(config);
  let output: Record<string, unknown>;
  if (input.structuredOutput) {
    output = input.structuredOutput;
  } else if (fields.length === 1 && fields[0] === "text") {
    output = { text: input.outputText };
  } else {
    output = parseRecord(input.outputText);
  }
  if (fields.some((field) => !Object.hasOwn(output, field))) throw new Error("workflow_output_invalid");
  const normalized = Object.fromEntries(fields.map((field) => [field, output[field]]));
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new Error("workflow_output_too_large");
  }
  return normalized;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function failWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  errorCode?: string;
  errorText: string;
}): { linked: boolean; retryScheduled: boolean; runId?: string } {
  return withTransaction(getDatabase(), () => {
    const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    if (!nodeRun) return { linked: false, retryScheduled: false };
    const failureCode = normalizeWorkflowFailureCode(input.errorCode);
    const run = failWorkflowNodeSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      taskQueueId: input.taskQueueId,
      errorCode: failureCode,
      errorMessage: undefined,
    });
    const failed = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    let retryScheduled = false;
    if (failed?.status === "failed"
      && failed.attemptCount < failed.maxAttempts
      && failureCode !== "workflow_completion_effect_uncertain") {
      retryWorkflowNodeSync({
        workspaceId: input.workspaceId,
        runId: failed.runId,
        nodeId: failed.nodeId,
        actorUserId: "workflow-retry-policy",
        reason: failureCode,
      });
      retryScheduled = true;
    }
    return { linked: true, retryScheduled, runId: run.id };
  });
}

export function normalizeWorkflowFailureCode(errorCode?: string): string {
  return errorCode && /^workflow_[a-z0-9_]+$/.test(errorCode)
    ? errorCode
    : "workflow_task_failed";
}

export function getWorkflowCompletionErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "workflow_completion_effect_uncertain" || error.message === "workflow_commit_snapshot_missing") {
    return "workflow_completion_effect_uncertain";
  }
  return error.message === "workflow_output_invalid" || error.message === "workflow_output_too_large"
    ? error.message
    : undefined;
}

export function resolveWorkflowCompletionFailureCode(input: {
  commitBoundaryCrossed: boolean;
  effectsCheckpointed: boolean;
  errorCode?: string;
}): string | undefined {
  if (input.commitBoundaryCrossed && !input.effectsCheckpointed) {
    return "workflow_completion_effect_uncertain";
  }
  return input.errorCode;
}
