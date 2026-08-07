"use server";

import {
  createWorkflowDefinitionSync,
  readWorkflowDefinitionSync,
  readWorkflowRunSync,
  readWorkflowTriggerForWorkflowSync,
  updateWorkflowDraftSync,
} from "@dofe-agent/db";
import { WORKFLOW_ERROR_CODE_SET, workflowErrorMessageZh, type WorkflowGraphDefinition } from "@dofe-agent/domain";
import {
  assertTriggerWriteOwnerSync,
  cancelWorkflowRunSync,
  materializeManualWorkflowRunSync,
  pauseWorkflowDefinitionSync,
  pauseWorkflowRunSync,
  publishWorkflowSync,
  resumeWorkflowDefinitionSync,
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
  channelName?: string;
  graph?: WorkflowGraphDefinition;
}

export interface UpdateWorkflowDraftActionInput {
  workflowId: string;
  expectedDraftVersion: number;
  patch: {
    name?: string;
    description?: string | null;
    channelName?: string | null;
    graph?: WorkflowGraphDefinition;
  };
}

export interface ValidateWorkflowInput {
  workflowId: string;
  graph?: WorkflowGraphDefinition;
  governance?: Record<string, unknown>;
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
    misfirePolicy?: "skip" | "fire_once";
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

export interface ControlWorkflowDefinitionActionInput {
  workflowId: string;
  action: "pause" | "resume";
  reason?: string;
}

export async function createWorkflowDraftAction(
  input: CreateWorkflowDraftInput,
): Promise<WorkflowActionResult<{ workflowId: string; draftVersion: number; graph: WorkflowGraphDefinition }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const definition = createWorkflowDefinitionSync({
      workspaceId: context.currentWorkspace.id,
      name: input.name.trim(),
      description: input.description?.trim(),
      channelName: input.channelName?.trim() || undefined,
      ownerUserId: context.currentUser.id,
      createdBy: context.currentUser.id,
      draftGraphJson: JSON.stringify(input.graph ?? emptyWorkflowGraph()),
    });
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, {
      workflowId: definition.id,
      draftVersion: definition.draftVersion,
      graph: parseWorkflowGraph(definition.draftGraphJson),
    });
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
    const definition = requireDefinition(input.workflowId, context.currentWorkspace.id);
    assertWorkflowManager(context, definition.ownerUserId);
    const updated = updateWorkflowDraftSync({
      id: input.workflowId,
      workspaceId: context.currentWorkspace.id,
      expectedDraftVersion: input.expectedDraftVersion,
      name: input.patch.name?.trim(),
      description: input.patch.description,
      channelName: input.patch.channelName,
      graphJson: input.patch.graph ? JSON.stringify(input.patch.graph) : undefined,
      updatedBy: context.currentUser.id,
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
      governance: input.governance,
      actor: actorFromContext(context),
    });
    return success(context.currentWorkspace.id, validation);
  } catch (error) {
    return failure(error);
  }
}

export async function publishWorkflowAction(
  input: PublishWorkflowActionInput,
): Promise<WorkflowActionResult<{ versionId: string; status: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "admin", "workspace role admin required");
  try {
    const definition = requireDefinition(input.workflowId, context.currentWorkspace.id);
    if (definition.draftVersion !== input.expectedDraftVersion) throw new Error("workflow_draft_version_conflict");
    if (input.trigger) assertTriggerWriteOwnerSync(context.currentWorkspace.id, "workflow");
    const currentTrigger = input.trigger
      ? readWorkflowTriggerForWorkflowSync(definition.id, context.currentWorkspace.id)
      : null;
    const result = publishWorkflowSync({
      workspaceId: context.currentWorkspace.id,
      workflowId: definition.id,
      graph: input.graph ?? parseWorkflowGraph(definition.draftGraphJson),
      governance: input.governance,
      actor: actorFromContext(context),
      expectedDraftVersion: input.expectedDraftVersion,
      trigger: input.trigger ? {
        id: currentTrigger?.id,
        type: input.trigger.type,
        configJson: JSON.stringify(input.trigger.config),
        timezone: input.trigger.timezone,
        nextFireAt: input.trigger.nextFireAt,
        misfirePolicy: input.trigger.misfirePolicy,
        status: "active",
      } : undefined,
    });
    const published = requireDefinition(definition.id, context.currentWorkspace.id);
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { versionId: result.version.id, status: published.status });
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

export async function controlWorkflowDefinitionAction(
  input: ControlWorkflowDefinitionActionInput,
): Promise<WorkflowActionResult<{ workflowId: string; status: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const definition = requireDefinition(input.workflowId, context.currentWorkspace.id);
    assertWorkflowManager(context, definition.ownerUserId);
    const control = {
      workspaceId: context.currentWorkspace.id,
      workflowId: input.workflowId,
      actorUserId: context.currentUser.id,
      reason: input.reason?.trim() || "workflow_definition_controlled",
    };
    const updated = input.action === "pause"
      ? pauseWorkflowDefinitionSync(control)
      : resumeWorkflowDefinitionSync(control);
    revalidateWorkflowPages(context.currentWorkspace.slug);
    return success(context.currentWorkspace.id, { workflowId: updated.id, status: updated.status });
  } catch (error) {
    return failure(error);
  }
}

export async function controlWorkflowRunAction(
  input: ControlWorkflowRunActionInput,
): Promise<WorkflowActionResult<{ runId: string; status: string }>> {
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "member");
  try {
    const currentRun = readWorkflowRunSync(input.runId, context.currentWorkspace.id);
    if (!currentRun) throw new Error("workflow_run_not_found");
    const definition = requireDefinition(currentRun.workflowId, context.currentWorkspace.id);
    assertWorkflowManager(context, definition.ownerUserId);
    const control = {
      workspaceId: context.currentWorkspace.id,
      runId: input.runId,
      actorUserId: context.currentUser.id,
      reason: input.reason?.trim() || "workflow_run_controlled",
    };
    if (input.action === "pause") pauseWorkflowRunSync(control);
    else if (input.action === "resume") resumeWorkflowRunSync(control);
    else if (input.action === "cancel") cancelWorkflowRunSync(control);
    else {
      if (!input.nodeId) throw new Error("workflow_node_run_not_found");
      retryWorkflowNodeSync({ ...control, nodeId: input.nodeId, manualOverride: true });
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
    : WORKFLOW_ERROR_CODE_SET.has(rawCode) ? rawCode : "workflow_operation_failed";
  const validation = error && typeof error === "object" && "validation" in error
    ? (error as { validation?: WorkflowPublishValidation }).validation
    : undefined;
  const blocker = validation?.blockers[0];
  return {
    ok: false,
    error: {
      code: blocker?.code ?? code,
      message: workflowErrorMessageZh(blocker?.code ?? code),
      ...(blocker?.nodeId ? { nodeId: blocker.nodeId } : {}),
    },
  };
}

function requireDefinition(workflowId: string, workspaceId: string) {
  const definition = readWorkflowDefinitionSync(workflowId, workspaceId);
  if (!definition) throw new Error("workflow_definition_not_found");
  return definition;
}

function assertWorkflowManager(
  context: Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>,
  workflowOwnerUserId: string,
): void {
  const role = context.currentMembership.role;
  if (role === "owner" || role === "admin" || workflowOwnerUserId === context.currentUser.id) return;
  throw new Error("workflow_actor_forbidden");
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
