import { Prisma, type PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import { getDofePrismaClient } from "./prisma-client.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";

export interface ReadyWorkflowNodeWithOutboxPrismaInput {
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  inputJson: Prisma.InputJsonObject;
  outboxId?: string;
  now: string;
}

/** The coordinator's pending-to-ready state change and dispatch notification. */
export async function readyWorkflowNodeWithOutboxPrisma(
  input: ReadyWorkflowNodeWithOutboxPrismaInput,
  client?: PrismaClient,
): Promise<{ transitioned: boolean; outboxId?: string }> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  return retryPrismaTransaction(() => prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM workflow_run WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    if (runs.length !== 1) throw new Error("workflow_run_not_found");
    const nodes = await tx.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM workflow_node_run WHERE id = ${input.nodeRunId} AND run_id = ${input.runId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    const node = nodes[0];
    if (!node) throw new Error("workflow_node_run_not_found");
    if (node.status !== "pending") return { transitioned: false };

    const updated = await tx.workflowNodeRun.updateMany({
      where: {
        id: input.nodeRunId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        status: "pending",
      },
      data: {
        status: "ready",
        availableAt: now,
        inputJson: input.inputJson,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) throw new Error("workflow_node_transition_conflict");
    const outboxId = input.outboxId?.trim() || `workflow-outbox-${randomLikeId()}`;
    await tx.workflowOutbox.create({
      data: {
        id: outboxId,
        workspaceId: input.workspaceId,
        aggregateType: "workflow_node_run",
        aggregateId: input.nodeRunId,
        eventType: "workflow.node.ready",
        payloadJson: { nodeRunId: input.nodeRunId },
        status: "pending",
        attempts: 0,
        availableAt: now,
        createdAt: now,
      },
    });
    return { transitioned: true, outboxId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), { scope: "workflow-coordinator" });
}
