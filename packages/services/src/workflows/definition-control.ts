import {
  getDatabase,
  pauseWorkflowTriggersForDefinitionSync,
  readWorkflowDefinitionSync,
  listWorkflowTriggersForWorkflowSync,
  recordAuditLogSync,
  transitionWorkflowDefinitionStatusSync,
  upsertWorkflowTriggerSync,
  withTransaction,
  type WorkflowDefinitionRecord,
} from "@dofe-agent/db";
import { isOneTimeWorkflowTrigger, normalizeWorkflowTriggerForPublish } from "./scheduler.ts";

export interface ControlWorkflowDefinitionInput {
  workspaceId: string;
  workflowId: string;
  actorUserId: string;
  reason: string;
  now?: string;
}

export function pauseWorkflowDefinitionSync(
  input: ControlWorkflowDefinitionInput,
): WorkflowDefinitionRecord {
  return withTransaction(getDatabase(), () => {
    const current = readWorkflowDefinitionSync(input.workflowId, input.workspaceId);
    if (!current) throw new Error("workflow_definition_not_found");
    if (current.status === "paused") return current;
    const now = input.now ?? new Date().toISOString();
    const paused = transitionWorkflowDefinitionStatusSync({
      id: input.workflowId,
      workspaceId: input.workspaceId,
      from: ["published"],
      to: "paused",
      now,
    });
    if (!paused) throw new Error("workflow_definition_control_conflict");
    pauseWorkflowTriggersForDefinitionSync({ workflowId: input.workflowId, workspaceId: input.workspaceId, now });
    recordDefinitionControlAudit(input, "workflow.definition.paused", now);
    return paused;
  });
}

export function resumeWorkflowDefinitionSync(
  input: ControlWorkflowDefinitionInput,
): WorkflowDefinitionRecord {
  return withTransaction(getDatabase(), () => {
    const current = readWorkflowDefinitionSync(input.workflowId, input.workspaceId);
    if (!current) throw new Error("workflow_definition_not_found");
    if (current.status === "published") return current;
    const now = input.now ?? new Date().toISOString();
    const resumed = transitionWorkflowDefinitionStatusSync({
      id: input.workflowId,
      workspaceId: input.workspaceId,
      from: ["paused"],
      to: "published",
      now,
    });
    if (!resumed) throw new Error("workflow_definition_control_conflict");

    const triggers = listWorkflowTriggersForWorkflowSync(input.workflowId, input.workspaceId)
      .filter((trigger) => trigger.status === "suspended");
    for (const trigger of triggers) {
      if (!canReactivateTrigger(trigger, now)) {
        upsertWorkflowTriggerSync({
          id: trigger.id,
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          type: trigger.type,
          configJson: trigger.configJson,
          timezone: trigger.timezone,
          status: "paused",
          nextFireAt: trigger.nextFireAt,
          lastFireAt: trigger.lastFireAt,
          misfirePolicy: trigger.misfirePolicy,
          dedupeWindowSeconds: trigger.dedupeWindowSeconds,
          now,
        });
        continue;
      }
      const normalized = normalizeWorkflowTriggerForPublish({
        id: trigger.id,
        type: trigger.type,
        configJson: trigger.configJson,
        timezone: trigger.timezone,
        status: "active",
        lastFireAt: trigger.lastFireAt,
        misfirePolicy: trigger.misfirePolicy,
        dedupeWindowSeconds: trigger.dedupeWindowSeconds,
        now,
      }, now);
      upsertWorkflowTriggerSync({
        ...normalized,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
      });
    }
    recordDefinitionControlAudit(input, "workflow.definition.resumed", now);
    return resumed;
  });
}

function canReactivateTrigger(
  trigger: ReturnType<typeof listWorkflowTriggersForWorkflowSync>[number],
  now: string,
): boolean {
  if (trigger.type !== "schedule" || !isOneTimeWorkflowTrigger(trigger)) return true;
  try {
    const config = JSON.parse(trigger.configJson) as { onceAt?: unknown };
    return typeof config.onceAt === "string" && Date.parse(config.onceAt) > Date.parse(now);
  } catch {
    return false;
  }
}

function recordDefinitionControlAudit(
  input: ControlWorkflowDefinitionInput,
  code: "workflow.definition.paused" | "workflow.definition.resumed",
  now: string,
): void {
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: code === "workflow.definition.paused" ? "工作流已暂停" : "工作流已恢复",
    note: input.workflowId,
    code,
    data: {
      workflowId: input.workflowId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      occurredAt: now,
    },
  });
}
