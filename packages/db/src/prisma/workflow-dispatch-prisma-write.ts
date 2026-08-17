import { Prisma, type PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import { getDofePrismaClient } from "./prisma-client.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";

export interface DispatchWorkflowNodePrismaInput {
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  employeeId: string;
  title: string;
  channelName?: string;
  priority?: "low" | "medium" | "high";
  inputJson: Record<string, unknown>;
  workflowMetadata: Record<string, unknown>;
  maxConcurrency: number;
  now: string;
  outbox?: { id: string; workerId: string };
}

export interface DispatchWorkflowNodePrismaResult {
  nodeRunId: string;
  status: string;
  taskQueueId?: string;
  reason: "claimed" | "already_queued" | "concurrency_limited" | "queue_unavailable" | "not_ready";
}

/**
 * The dispatcher write boundary. All state that makes a node dispatchable is
 * committed together: node CAS claim, binding/session resolution, queue row,
 * router/task events, run event sequence, and (when invoked by the outbox
 * worker) the outbox lease acknowledgement.
 */
export async function dispatchWorkflowNodePrisma(
  input: DispatchWorkflowNodePrismaInput,
  client: PrismaClient = getDofePrismaClient(),
): Promise<DispatchWorkflowNodePrismaResult> {
  return retryPrismaTransaction(() => client.$transaction(
    (tx) => dispatchWorkflowNodePrismaInTransaction(input, tx),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/** Claim the ready outbox row and dispatch the node under one transaction. */
export async function dispatchWorkflowNodeFromOutboxPrisma(
  input: DispatchWorkflowNodePrismaInput & { outbox: { id: string; workerId: string } },
  client: PrismaClient = getDofePrismaClient(),
): Promise<DispatchWorkflowNodePrismaResult> {
  return retryPrismaTransaction(() => client.$transaction(
    async (tx) => {
      const leaseUntil = new Date(Date.parse(input.now) + 60_000);
      const claimed = await tx.workflowOutbox.updateMany({
        where: {
          id: input.outbox.id,
          workspaceId: input.workspaceId,
          status: "pending",
          availableAt: { lte: new Date(input.now) },
          OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(input.now) } }],
        },
        data: { lockedAt: leaseUntil, lockedBy: input.outbox.workerId, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) throw new Error("workflow_outbox_lease_conflict");
      return dispatchWorkflowNodePrismaInTransaction(input, tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

export function isWorkflowDispatcherPrismaWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKFLOW_DISPATCHER_PRISMA_WRITE_ENABLED === "1";
}

async function dispatchWorkflowNodePrismaInTransaction(
  input: DispatchWorkflowNodePrismaInput,
  tx: Prisma.TransactionClient,
): Promise<DispatchWorkflowNodePrismaResult> {
  const lockedRun = await tx.$queryRaw<Array<{ id: string; status: string }>>(
    Prisma.sql`SELECT id, status FROM workflow_run WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
  );
  if (lockedRun.length !== 1) throw new Error("workflow_run_not_found");
  const node = await tx.workflowNodeRun.findFirst({
    where: { id: input.nodeRunId, workspaceId: input.workspaceId },
  });
  if (!node) throw new Error("workflow_node_run_not_found");
  if (isWorkflowRunDispatchBlocked(lockedRun[0]!.status)) {
    await publishOutboxInTransaction(input, tx);
    return { nodeRunId: node.id, status: node.status, taskQueueId: node.taskQueueId ?? undefined, reason: "not_ready" };
  }
  if (node.status === "queued" && node.taskQueueId) {
    await publishOutboxInTransaction(input, tx);
    return { nodeRunId: node.id, status: node.status, taskQueueId: node.taskQueueId, reason: "already_queued" };
  }
  if (node.status !== "ready") {
    await publishOutboxInTransaction(input, tx);
    return { nodeRunId: node.id, status: node.status, reason: "not_ready" };
  }

  const activeCount = await tx.workflowNodeRun.count({
    where: { workspaceId: input.workspaceId, runId: node.runId, status: { in: ["queued", "running"] } },
  });
  if (activeCount >= Math.max(1, input.maxConcurrency)) {
    const availableAt = new Date(Date.parse(input.now) + 5_000);
    const updated = await tx.workflowNodeRun.updateMany({
      where: { id: node.id, workspaceId: input.workspaceId, status: "ready" },
      data: {
        status: "retry_wait",
        availableAt,
        errorCode: "workflow_concurrency_limited",
        errorMessage: `max_concurrency_${input.maxConcurrency}`,
        updatedAt: new Date(input.now),
      },
    });
    if (updated.count !== 1) {
      await publishOutboxInTransaction(input, tx);
      return { nodeRunId: node.id, status: "ready", reason: "not_ready" };
    }
    await appendRunEventInTransaction(tx, {
      workspaceId: input.workspaceId,
      runId: node.runId,
      nodeRunId: node.id,
      type: "node.concurrency_wait",
      actorType: "dispatcher",
      dataJson: { maxConcurrency: input.maxConcurrency, availableAt: availableAt.toISOString() },
      now: input.now,
    });
    await publishOutboxInTransaction(input, tx);
    return { nodeRunId: node.id, status: "retry_wait", reason: "concurrency_limited" };
  }

  const claimed = await tx.workflowNodeRun.updateMany({
    where: { id: node.id, workspaceId: input.workspaceId, status: "ready" },
    data: { status: "queued", errorCode: null, errorMessage: null, updatedAt: new Date(input.now) },
  });
  if (claimed.count !== 1) {
    await publishOutboxInTransaction(input, tx);
    return { nodeRunId: node.id, status: "ready", reason: "not_ready" };
  }

  const employee = await tx.workspaceEmployee.findFirst({
    where: { id: input.employeeId, workspaceId: input.workspaceId },
    select: { id: true, name: true },
  });
  if (!employee) return deferQueueUnavailableInTransaction(input, node, tx);
  const binding = await tx.employeeRuntimeBinding.findUnique({
    where: { workspaceId_employeeId: { workspaceId: input.workspaceId, employeeId: employee.id } },
    include: { runtime: { select: { id: true, name: true, provider: true } } },
  });
  if (!binding || binding.status === "offline" || binding.status === "needs_attention") {
    return deferQueueUnavailableInTransaction(input, node, tx);
  }

  const queueId = `queue-workflow-${node.id}`;
  const payload = {
    assignee: employee.name,
    title: input.title,
    ...(input.channelName ? { channel: input.channelName } : {}),
    priority: input.priority ?? "medium",
    ...input.inputJson,
    workflow: input.workflowMetadata,
  } as Prisma.InputJsonObject;
  const conversationKey = `workspace_task:${node.id}`;
  const existingSession = await tx.agentRouterSession.findFirst({
    where: { workspaceId: input.workspaceId, agentId: binding.employeeId, conversationKey },
  });
  const session = existingSession
    ? await tx.agentRouterSession.update({
      where: { id: existingSession.id },
      data: { sourceType: "workspace_task", status: "active", title: input.title, updatedAt: new Date(input.now), closedAt: null },
    })
    : await tx.agentRouterSession.create({
      data: {
        id: `router-session-${randomLikeId()}`,
        workspaceId: input.workspaceId,
        agentId: binding.employeeId,
        conversationKey,
        sourceType: "workspace_task",
        status: "active",
        title: input.title,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      },
    });

  const existingTask = await tx.agentTaskQueue.findUnique({ where: { id: queueId } });
  const task = existingTask ?? await tx.agentTaskQueue.create({
    data: {
      id: queueId,
      workspaceId: input.workspaceId,
      agentId: employee.name,
      employeeId: binding.employeeId,
      employeeName: binding.employeeName,
      runtimeId: binding.runtimeId,
      routerSessionId: session.id,
      issueId: node.id,
      triggerType: "workflow",
      priority: priorityToNumber(input.priority),
      status: "queued",
      inputJson: payload,
      queuedAt: new Date(input.now),
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    },
  });
  const linked = await tx.workflowNodeRun.updateMany({
    where: { id: node.id, workspaceId: input.workspaceId, status: "queued", taskQueueId: null },
    data: { taskQueueId: task.id, updatedAt: new Date(input.now) },
  });
  if (linked.count !== 1) throw new Error("workflow_node_queue_link_conflict");
  if (!existingTask) {
    await tx.agentRouterEvent.create({
      data: {
        id: `router-event-${randomLikeId()}`,
        workspaceId: input.workspaceId,
        routerSessionId: session.id,
        taskQueueId: task.id,
        type: "task_queued",
        actorType: "system",
        runtimeId: binding.runtimeId,
        provider: binding.runtime.provider,
        summary: input.title,
        dataJson: { preferredRuntimeId: binding.runtimeId, nodeRunId: node.id } as Prisma.InputJsonObject,
        createdAt: new Date(input.now),
      },
    });
    await tx.taskExecutionEvent.create({
      data: {
        id: `task-event-${randomLikeId()}`,
        workspaceId: input.workspaceId,
        taskId: task.id,
        channelName: input.channelName ?? "",
        agentId: employee.name,
        runtimeId: binding.runtimeId,
        runId: node.runId,
        type: "queued",
        title: "Task entered the execution queue",
        summary: `${input.title} is waiting for ${binding.runtime.name}.`,
        severity: "info",
        status: "pending",
        dataJson: { nodeRunId: node.id, preferredRuntimeId: binding.runtimeId } as Prisma.InputJsonObject,
        createdAt: new Date(input.now),
      },
    });
  }
  await appendRunEventInTransaction(tx, {
    workspaceId: input.workspaceId,
    runId: node.runId,
    nodeRunId: node.id,
    type: "node.queued",
    actorType: "dispatcher",
    dataJson: { taskQueueId: task.id, runtimeId: binding.runtimeId } as Prisma.InputJsonObject,
    now: input.now,
  });
  await publishOutboxInTransaction(input, tx);
  return { nodeRunId: node.id, status: "queued", taskQueueId: task.id, reason: "claimed" };
}

async function deferQueueUnavailableInTransaction(
  input: DispatchWorkflowNodePrismaInput,
  node: { id: string; runId: string },
  tx: Prisma.TransactionClient,
): Promise<DispatchWorkflowNodePrismaResult> {
  const availableAt = new Date(Date.parse(input.now) + 60_000);
  const updated = await tx.workflowNodeRun.updateMany({
    where: { id: node.id, workspaceId: input.workspaceId, status: "queued" },
    data: {
      status: "retry_wait",
      availableAt,
      taskQueueId: null,
      errorCode: "workflow_task_queue_unavailable",
      errorMessage: "workflow_task_queue_unavailable",
      updatedAt: new Date(input.now),
    },
  });
  if (updated.count !== 1) throw new Error("workflow_node_queue_retry_conflict");
  await appendRunEventInTransaction(tx, {
    workspaceId: input.workspaceId,
    runId: node.runId,
    nodeRunId: node.id,
    type: "node.queue_blocked",
    actorType: "dispatcher",
    severity: "warning",
    dataJson: { code: "workflow_task_queue_unavailable", availableAt: availableAt.toISOString() },
    now: input.now,
  });
  await publishOutboxInTransaction(input, tx);
  return { nodeRunId: node.id, status: "retry_wait", reason: "queue_unavailable" };
}

async function appendRunEventInTransaction(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; runId: string; nodeRunId: string; type: string; actorType: string; severity?: string; dataJson: Record<string, unknown>; now: string },
): Promise<void> {
  const run = await tx.workflowRun.update({
    where: { id: input.runId },
    data: { currentSequence: { increment: 1 }, updatedAt: new Date(input.now) },
    select: { workspaceId: true, currentSequence: true },
  });
  if (run.workspaceId !== input.workspaceId) throw new Error("workflow_workspace_mismatch");
  await tx.workflowRunEvent.create({
    data: {
      id: `workflow-event-${randomLikeId()}`,
      workspaceId: input.workspaceId,
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      sequence: run.currentSequence,
      type: input.type,
      actorType: input.actorType,
      severity: input.severity ?? "info",
      dataJson: input.dataJson as Prisma.InputJsonObject,
      createdAt: new Date(input.now),
    },
  });
}

async function publishOutboxInTransaction(input: DispatchWorkflowNodePrismaInput, tx: Prisma.TransactionClient): Promise<void> {
  if (!input.outbox) return;
  const updated = await tx.workflowOutbox.updateMany({
    where: {
      id: input.outbox.id,
      workspaceId: input.workspaceId,
      status: "pending",
      lockedBy: input.outbox.workerId,
    },
    data: { status: "published", publishedAt: new Date(input.now), lockedAt: null, lockedBy: null },
  });
  if (updated.count !== 1) throw new Error("workflow_outbox_lease_conflict");
}

function priorityToNumber(priority: "low" | "medium" | "high" | undefined): number {
  return priority === "high" ? 1 : priority === "low" ? -1 : 0;
}

function isWorkflowRunDispatchBlocked(status: string): boolean {
  return ["paused", "cancelled", "failed", "succeeded", "partially_succeeded"].includes(status);
}
