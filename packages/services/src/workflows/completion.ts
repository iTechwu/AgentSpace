import { readWorkflowNodeRunByTaskQueueIdSync } from "@dofe-agent/db";
import { completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";

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
  return { linked: true, retryScheduled: false, runId: run.id };
}
