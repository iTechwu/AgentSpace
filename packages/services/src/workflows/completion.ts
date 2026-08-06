import {
  appendWorkflowRunEventSync,
  getDatabase,
  lockWorkflowRunForUpdateSync,
  readQueuedTaskSync,
  readWorkflowNodeRunByTaskQueueIdSync,
  startQueuedTaskSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import { completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";
import { workflowNodeOutputFields } from "./inputs.ts";
import { retryWorkflowNodeSync } from "./retries.ts";

const MAX_WORKFLOW_OUTPUT_BYTES = 256 * 1024;

export function startQueuedTaskWithWorkflowSync(input: {
  workspaceId: string;
  taskQueueId: string;
}): QueuedTaskRecord {
  return withTransaction(getDatabase(), () => {
    const candidate = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    if (!candidate) return startQueuedTaskSync(input.taskQueueId);
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    const currentTask = readQueuedTaskSync(input.taskQueueId);
    if (!nodeRun || !currentTask) throw new Error("workflow_task_queue_mismatch");
    if (["completed", "failed", "cancelled"].includes(currentTask.status)
      || ["succeeded", "failed", "skipped", "cancelled"].includes(nodeRun.status)) {
      return currentTask;
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
      transitionWorkflowRunSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        from: ["created", "queued"],
        to: "running",
        startedAt: now,
        now,
      });
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
    return started;
  });
}

export function lockWorkflowRunForTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
}): boolean {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return false;
  if (!lockWorkflowRunForUpdateSync(nodeRun.runId, input.workspaceId)) {
    throw new Error("workflow_run_not_found");
  }
  return true;
}

export function completeWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  outputText: string;
  structuredOutput?: Record<string, unknown>;
  artifactManifest: unknown[];
}): { linked: boolean; runId?: string } {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return { linked: false };
  const run = completeWorkflowNodeSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    taskQueueId: input.taskQueueId,
    output: normalizeWorkflowNodeOutput({
      outputText: input.outputText,
      structuredOutput: input.structuredOutput,
      nodeConfigJson: nodeRun.inputJson,
    }),
    artifactManifest: input.artifactManifest,
  });
  return { linked: true, runId: run.id };
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
    const run = failWorkflowNodeSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      taskQueueId: input.taskQueueId,
      errorCode: normalizeWorkflowFailureCode(input.errorCode),
      errorMessage: undefined,
    });
    const failed = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
    let retryScheduled = false;
    if (failed?.status === "failed" && failed.attemptCount < failed.maxAttempts) {
      retryWorkflowNodeSync({
        workspaceId: input.workspaceId,
        runId: failed.runId,
        nodeId: failed.nodeId,
        actorUserId: "workflow-retry-policy",
        reason: normalizeWorkflowFailureCode(input.errorCode),
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
  return error.message === "workflow_output_invalid" || error.message === "workflow_output_too_large"
    ? error.message
    : undefined;
}
