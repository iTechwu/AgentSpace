import {
  listActiveWorkflowEventTriggersSync,
  type WorkflowTriggerRecord,
} from "@dofe-agent/db";
import { materializeWorkflowRunSync } from "./materialization.ts";

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_INPUT_BYTES = 65_536;

export interface WorkflowEventInput {
  workspaceId: string;
  eventName: string;
  eventId: string;
  input?: Record<string, unknown>;
  createdBy?: string;
  now?: string;
}

export interface WorkflowEventResult {
  matchedTriggerIds: string[];
  createdRunIds: string[];
  deduplicatedTriggerIds: string[];
}

export function fireWorkflowEventSync(rawInput: WorkflowEventInput): WorkflowEventResult {
  const input = normalizeWorkflowEventInput(rawInput);
  const now = rawInput.now ?? new Date().toISOString();
  const triggers = listActiveWorkflowEventTriggersSync(input.workspaceId)
    .filter((trigger) => workflowTriggerMatchesEvent(trigger, input.eventName));
  const result: WorkflowEventResult = {
    matchedTriggerIds: triggers.map((trigger) => trigger.id),
    createdRunIds: [],
    deduplicatedTriggerIds: [],
  };
  for (const trigger of triggers) {
    let materialized;
    try {
      materialized = materializeWorkflowRunSync({
        workspaceId: input.workspaceId,
        trigger,
        scheduledAt: `event:${input.eventId}`,
        inputJson: JSON.stringify(input.input ?? {}),
        createdBy: rawInput.createdBy,
        now,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "workflow_definition_not_published") continue;
      throw error;
    }
    if (materialized.created) result.createdRunIds.push(materialized.runId);
    else result.deduplicatedTriggerIds.push(trigger.id);
  }
  return result;
}

export function normalizeWorkflowEventInput(input: WorkflowEventInput): Required<Pick<WorkflowEventInput, "workspaceId" | "eventName" | "eventId">> & { input?: Record<string, unknown> } {
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  const eventName = typeof input.eventName === "string" ? input.eventName.trim() : "";
  const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
  if (!workspaceId || !EVENT_NAME.test(eventName) || !eventId || eventId.length > MAX_EVENT_ID_LENGTH) {
    throw new Error("workflow_event_invalid");
  }
  if (input.input !== undefined && (!input.input || typeof input.input !== "object" || Array.isArray(input.input))) {
    throw new Error("workflow_event_invalid");
  }
  if (Buffer.byteLength(JSON.stringify(input.input ?? {}), "utf8") > MAX_INPUT_BYTES) {
    throw new Error("workflow_event_payload_too_large");
  }
  return { workspaceId, eventName, eventId, ...(input.input ? { input: input.input } : {}) };
}

export function workflowTriggerMatchesEvent(
  trigger: Pick<WorkflowTriggerRecord, "type" | "status" | "configJson">,
  eventName: string,
): boolean {
  if (trigger.type !== "event" || trigger.status !== "active") return false;
  try {
    const config = JSON.parse(trigger.configJson) as unknown;
    return Boolean(config && typeof config === "object" && !Array.isArray(config)
      && (config as Record<string, unknown>).eventName === eventName);
  } catch {
    return false;
  }
}
