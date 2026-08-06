"use server";

import {
  createWorkflowDefinitionSync,
  readWorkflowDefinitionSync,
  readWorkflowRunSync,
  updateWorkflowDraftSync,
  upsertWorkflowTriggerSync,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import {
  cancelWorkflowRunSync,
  materializeManualWorkflowRunSync,
  pauseWorkflowRunSync,
  publishWorkflowSync,
  resumeWorkflowRunSync,
  retryWorkflowNodeSync,
  validateWorkflowForPublishSync,
  type WorkflowPublishValidation,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";

export type WorkflowActionResult<T> =
  | { ok: true; data: T; invalidation: WorkspaceInvalidationEvent }
  | { ok: false; error: { code: string; message: string; field?: string; nodeId?: string } };

export interface CreateWorkflowDraftInput {
  name: string;
  description?: string;
  graph?: WorkflowGraphDefinition;
}

export interface UpdateWorkflowDraftActionInput {
  workflowId: string;
  expectedDraftVersion: number;
  patch: {
    name?: string;
    description?: string | null;
    ownerUserId?: string;
    channelName?: string | null;
    graph?: WorkflowGraphDefinition;
  };
}

export interface ValidateWorkflowInput {
  workflowId: string;
  graph?: WorkflowGraphDefinition;
}

export interface PublishWorkflowActionInput {
  workflowId: string;
  expectedDraftVersion: number;
  graph?: WorkflowGraphDefinition;
  governance?: Record<string, unknown>;
  trigger?: {
    type: "manual" | "schedule" | "event";
    config: Record<string, unknown>;
    timezone?: string;
    nextFireAt?: string;
  };
}

export interface RunWorkflowActionInput {
  workflowId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
}

export interface ControlWorkflowRunActionInput {
  runId: string;
  action: "pause" | "resume" | "cancel" | "retry_node";
  nodeId?: string;
  reason?: string;
}

export async function createWorkflowDraftAction(
  input: CreateWorkflowDraftInput,
): Promise<WorkflowActionResult<{ workflowId: string; draftVersion: number }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const definition = createWorkflowDefinitionSync({
      workspaceId: context.currentWorkspace.id,
      name: input.name.trim(),
      description: input.description?.trim(),
      ownerUserId: context.currentUser.id,
      createdBy: context.currentUser.id,
      draftGraphJson: JSON.stringify(input.graph ?? emptyWorkflowGraph()),
    });
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { workflowId: definition.id, draftVersion: definition.draftVersion });
  } catch (error) {
    return failure(error);
  }
}

export async function updateWorkflowDraftAction(
  input: UpdateWorkflowDraftActionInput,
): Promise<WorkflowActionResult<{ draftVersion: number; graph: WorkflowGraphDefinition }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const updated = updateWorkflowDraftSync({
      id: input.workflowId,
      workspaceId: context.currentWorkspace.id,
      expectedDraftVersion: input.expectedDraftVersion,
      name: input.patch.name?.trim(),
      description: input.patch.description,
      ownerUserId: input.patch.ownerUserId,
      channelName: input.patch.channelName,
      graphJson: input.patch.graph ? JSON.stringify(input.patch.graph) : undefined,
    });
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, {
      draftVersion: updated.draftVersion,
      graph: parseWorkflowGraph(updated.draftGraphJson),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function validateWorkflowAction(
  input: ValidateWorkflowInput,
): Promise<WorkflowActionResult<WorkflowPublishValidation>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const definition = requireDefinition(input.workflowId, context.currentWorkspace.id);
    const validation = validateWorkflowForPublishSync({
      workspaceId: context.currentWorkspace.id,
      graph: input.graph ?? parseWorkflowGraph(definition.draftGraphJson),
      actor: actorFromContext(context),
    });
    return success(context.currentWorkspace.id, validation);
  } catch (error) {
    return failure(error);
  }
}

export async function publishWorkflowAction(
  input: PublishWorkflowActionInput,
): Promise<WorkflowActionResult<{ versionId: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "admin", "workspace role admin required");
  try {
    const definition = requireDefinition(input.workflowId, context.currentWorkspace.id);
    if (definition.draftVersion !== input.expectedDraftVersion) throw new Error("workflow_draft_version_conflict");
    const result = publishWorkflowSync({
      workspaceId: context.currentWorkspace.id,
      workflowId: definition.id,
      graph: input.graph ?? parseWorkflowGraph(definition.draftGraphJson),
      governance: input.governance,
      actor: actorFromContext(context),
    });
    if (input.trigger) {
      upsertWorkflowTriggerSync({
        workspaceId: context.currentWorkspace.id,
        workflowId: definition.id,
        type: input.trigger.type,
        configJson: JSON.stringify(input.trigger.config),
        timezone: input.trigger.timezone,
        nextFireAt: input.trigger.nextFireAt,
        status: "active",
      });
    }
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { versionId: result.version.id });
  } catch (error) {
    return failure(error);
  }
}

export async function runWorkflowAction(
  input: RunWorkflowActionInput,
): Promise<WorkflowActionResult<{ runId: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const result = materializeManualWorkflowRunSync({
      workspaceId: context.currentWorkspace.id,
      workflowId: input.workflowId,
      idempotencyKey: input.idempotencyKey,
      inputJson: JSON.stringify(input.input),
      createdBy: context.currentUser.id,
    });
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { runId: result.runId });
  } catch (error) {
    return failure(error);
  }
}

export async function controlWorkflowRunAction(
  input: ControlWorkflowRunActionInput,
): Promise<WorkflowActionResult<{ runId: string; status: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  const control = {
    workspaceId: context.currentWorkspace.id,
    runId: input.runId,
    actorUserId: context.currentUser.id,
    reason: input.reason?.trim() || "workflow_run_controlled",
  };
  try {
    if (input.action === "pause") pauseWorkflowRunSync(control);
    else if (input.action === "resume") resumeWorkflowRunSync(control);
    else if (input.action === "cancel") cancelWorkflowRunSync(control);
    else {
      if (!input.nodeId) throw new Error("workflow_node_run_not_found");
      retryWorkflowNodeSync({ ...control, nodeId: input.nodeId });
    }
    const run = readWorkflowRunSync(input.runId, context.currentWorkspace.id);
    if (!run) throw new Error("workflow_run_not_found");
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { runId: run.id, status: run.status });
  } catch (error) {
    return failure(error);
  }
}

function success<T>(workspaceId: string, data: T): WorkflowActionResult<T> {
  return { ok: true, data, invalidation: { workspaceId, modules: ["automations", "calendar", "task-board"] } };
}

function failure(error: unknown): WorkflowActionResult<never> {
  const rawCode = error instanceof Error ? error.message : "workflow_unknown_error";
  const code = rawCode === "workflow_draft_version_conflict" || rawCode === "workflow_definition_conflict"
    ? "workflow_version_conflict"
    : STABLE_ERROR_CODES.has(rawCode) ? rawCode : "workflow_operation_failed";
  const validation = error && typeof error === "object" && "validation" in error
    ? (error as { validation?: WorkflowPublishValidation }).validation
    : undefined;
  const blocker = validation?.blockers[0];
  return {
    ok: false,
    error: {
      code: blocker?.code ?? code,
      message: workflowErrorMessage(blocker?.code ?? code),
      ...(blocker?.nodeId ? { nodeId: blocker.nodeId } : {}),
    },
  };
}

const STABLE_ERROR_CODES = new Set([
  "workflow_definition_not_found", "workflow_definition_archived", "workflow_definition_not_published",
  "workflow_actor_forbidden", "workflow_employee_not_ready", "workflow_run_not_found", "workflow_run_control_conflict",
  "workflow_node_run_not_found", "workflow_node_not_retryable", "workflow_node_retry_exhausted", "workflow_node_retry_conflict",
  "workflow_trigger_cross_workspace_conflict", "workflow_trigger_duplicate", "workflow_active_version_missing",
]);

function workflowErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    workflow_version_conflict: "草稿已被其他编辑者更新，请刷新后重试。",
    workflow_definition_not_found: "未找到工作流。",
    workflow_definition_archived: "已归档的工作流不能编辑。",
    workflow_definition_not_published: "请先发布工作流。",
    workflow_employee_not_ready: "工作流中的 AI 员工尚未就绪。",
    workflow_run_not_found: "未找到运行记录。",
    workflow_run_control_conflict: "运行状态已变化，请刷新后重试。",
    workflow_node_retry_exhausted: "该步骤已达到最大重试次数。",
  };
  return messages[code] ?? "工作流操作未完成，请稍后重试。";
}

function requireDefinition(workflowId: string, workspaceId: string) {
  const definition = readWorkflowDefinitionSync(workflowId, workspaceId);
  if (!definition) throw new Error("workflow_definition_not_found");
  return definition;
}

function parseWorkflowGraph(value: string): WorkflowGraphDefinition {
  const parsed = JSON.parse(value) as WorkflowGraphDefinition;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error("workflow_graph_invalid");
  return parsed;
}

function emptyWorkflowGraph(): WorkflowGraphDefinition {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

function actorFromContext(context: Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>) {
  return {
    userId: context.currentUser.id,
    displayName: context.currentUser.displayName,
    role: context.currentMembership.role === "member" ? "editor" as const : context.currentMembership.role,
  };
}

function revalidateWorkflowPages(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/automations", "/calendar", "/task/board"]);
}
