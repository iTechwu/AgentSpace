import {
  publishWorkflowVersionSync,
  type PublishWorkflowVersionInput,
  type UpsertWorkflowTriggerInput,
  type WorkflowVersionRecord,
} from "@dofe-agent/db";
import {
  canonicalizeWorkflowGraph,
  canonicalizeJson,
  hashWorkflowGraph,
  validateWorkflowForPublishSync,
  type ValidateWorkflowForPublishInput,
  type WorkflowPublishValidation,
} from "./validation.ts";
import { normalizeWorkflowTriggerForPublish } from "./scheduler.ts";

export interface PublishWorkflowInput extends ValidateWorkflowForPublishInput {
  workflowId: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  versionNumber?: number;
  trigger?: Omit<UpsertWorkflowTriggerInput, "workspaceId" | "workflowId">;
}

export interface PublishWorkflowResult {
  version: WorkflowVersionRecord;
  validation: WorkflowPublishValidation;
}

export function publishWorkflowSync(input: PublishWorkflowInput): PublishWorkflowResult {
  const validation = validateWorkflowForPublishSync(input);
  if (validation.blockers.length > 0) {
    const first = validation.blockers[0]!;
    const error = new Error(first.code);
    Object.assign(error, { validation });
    throw error;
  }

  const versionInput: PublishWorkflowVersionInput = {
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    graphJson: canonicalizeWorkflowGraph(input.graph),
    inputSchemaJson: canonicalizeJson(input.inputSchema ?? {}),
    outputSchemaJson: canonicalizeJson(input.outputSchema ?? {}),
    governanceJson: canonicalizeJson(input.governance ?? {}),
    contentHash: hashWorkflowGraph(input.graph),
    publishedBy: input.actor.userId,
    versionNumber: input.versionNumber,
    trigger: input.trigger ? normalizeWorkflowTriggerForPublish(input.trigger) : undefined,
  };
  const version = publishWorkflowVersionSync(versionInput);
  return { version, validation };
}
