import { readWorkflowNodeRunByTaskQueueIdSync } from "@dofe-agent/db";
import { completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";
import { retryWorkflowNodeSync } from "./retries.ts";

export function completeWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  outputText: string;
  artifactManifest: unknown[];
}): { linked: boolean; runId?: string } {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return { linked: false };
  const run = completeWorkflowNodeSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    taskQueueId: input.taskQueueId,
    output: { text: input.outputText },
    artifactManifest: input.artifactManifest,
  });
  return { linked: true, runId: run.id };
}

export function failWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  errorCode?: string;
  errorText: string;
}): { linked: boolean; retryScheduled: boolean; runId?: string } {
  const nodeRun = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  if (!nodeRun) return { linked: false, retryScheduled: false };
  const run = failWorkflowNodeSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    taskQueueId: input.taskQueueId,
    errorCode: input.errorCode,
    errorMessage: input.errorText,
  });
  const failed = readWorkflowNodeRunByTaskQueueIdSync(input.taskQueueId, input.workspaceId);
  let retryScheduled = false;
  if (failed?.status === "failed" && failed.attemptCount < failed.maxAttempts) {
    retryWorkflowNodeSync({
      workspaceId: input.workspaceId,
      runId: failed.runId,
      nodeId: failed.nodeId,
      actorUserId: "workflow-retry-policy",
      reason: input.errorText,
    });
    retryScheduled = true;
  }
  return { linked: true, retryScheduled, runId: run.id };
}
