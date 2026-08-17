import { isWorkflowNodeType, type WorkflowGraphDefinition } from "@dofe-agent/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import type { WorkflowTriggerRecord } from "../types.ts";
import { getDofePrismaClient } from "./prisma-client.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";

export interface MaterializeWorkflowRunPrismaInput {
  workspaceId: string;
  trigger: WorkflowTriggerRecord;
  scheduledAt: string;
  createdBy?: string;
  inputJson?: string;
  now: string;
  triggerAdvance?: {
    workerId: string;
    nextFireAt: string | null;
    status?: string;
    misfired?: boolean;
    outcome?: {
      code: "workflow.trigger.misfire_fire_once";
      reasonCode: string;
    };
  };
}

export interface MaterializeWorkflowRunPrismaResult {
  runId: string;
  created: boolean;
}

/** Materialize all run state and its run.ready notification in one Serializable transaction. */
export async function materializeWorkflowRunPrisma(
  input: MaterializeWorkflowRunPrismaInput,
  client?: PrismaClient,
): Promise<MaterializeWorkflowRunPrismaResult> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  return retryPrismaTransaction(() => prisma.$transaction(async (tx) => {
    const definitions = await tx.$queryRaw<Array<{ status: string; active_version_id: string | null }>>(
      Prisma.sql`SELECT status, active_version_id FROM workflow_definition WHERE id = ${input.trigger.workflowId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    const definition = definitions[0];
    if (!definition) throw new Error("workflow_definition_not_found");
    if (definition.status !== "published") throw new Error("workflow_definition_not_published");

    const triggerRows = await tx.$queryRaw<Array<{
      workflow_id: string;
      type: string;
      status: string;
      config_json: unknown;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      updated_at: Date;
    }>>(
      Prisma.sql`SELECT workflow_id, type, status, config_json, lease_owner, lease_expires_at, updated_at FROM workflow_trigger WHERE id = ${input.trigger.id} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    assertTriggerSnapshot(input.trigger, triggerRows[0]);
    if (!definition.active_version_id) throw new Error("workflow_active_version_missing");
    const version = await tx.workflowVersion.findFirst({
      where: { id: definition.active_version_id, workspaceId: input.workspaceId, workflowId: input.trigger.workflowId },
    });
    if (!version) throw new Error("workflow_active_version_missing");
    const graph = parseWorkflowGraph(version.graphJson);
    const triggerKey = `${input.trigger.workflowId}:${input.trigger.id}:${input.scheduledAt}`;
    const existing = await tx.workflowRun.findFirst({
      where: { workspaceId: input.workspaceId, triggerKey },
      select: { id: true },
    });

    let runId = existing?.id;
    let created = false;
    if (!runId) {
      const sequenceRows = await tx.$queryRaw<Array<{ workflow_run_sequence: bigint }>>(
        Prisma.sql`UPDATE workspace SET workflow_run_sequence = workflow_run_sequence + 1 WHERE id = ${input.workspaceId} RETURNING workflow_run_sequence`,
      );
      const historySequence = sequenceRows[0]?.workflow_run_sequence;
      if (historySequence === undefined) throw new Error("workflow_workspace_mismatch");
      const newRunId = `workflow-run-${randomLikeId()}`;
      runId = newRunId;
      await tx.workflowRun.create({
        data: {
          id: newRunId,
          workspaceId: input.workspaceId,
          workflowId: input.trigger.workflowId,
          versionId: version.id,
          triggerId: input.trigger.id,
          triggerType: input.trigger.type,
          triggerKey,
          historySequence,
          inputJson: parseJsonObject(input.inputJson ?? "{}", "workflow_input_json_invalid"),
          budgetJson: normalizeJsonObject(version.governanceJson, "workflow_governance_json_invalid"),
          status: "created",
          currentSequence: 0,
          createdBy: input.createdBy ?? "system",
          createdAt: now,
          updatedAt: now,
        },
      });
      const employeeIds = graph.nodes.flatMap((node) => node.employeeId ? [node.employeeId] : []);
      const employees = employeeIds.length === 0 ? [] : await tx.workspaceEmployee.findMany({
        where: { workspaceId: input.workspaceId, id: { in: employeeIds } },
        select: { id: true, name: true, remarkName: true },
      });
      const employeeNames = new Map(employees.map((employee) => [employee.id, employee.remarkName?.trim() || employee.name]));
      await tx.workflowNodeRun.createMany({
        data: graph.nodes.map((node) => ({
          id: `workflow-node-run-${randomLikeId()}`,
          workspaceId: input.workspaceId,
          runId: newRunId,
          nodeId: node.id,
          nodeType: node.type,
          employeeId: node.employeeId ?? null,
          employeeNameSnapshot: node.employeeId ? employeeNames.get(node.employeeId) ?? null : null,
          status: "pending",
          attemptCount: 1,
          maxAttempts: readMaxAttempts(node.config),
          inputJson: node.config as Prisma.InputJsonObject,
          createdAt: now,
          updatedAt: now,
        })),
      });
      const incoming = new Set(graph.edges.map((edge) => edge.target));
      const rootNodeIds = graph.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
      if (rootNodeIds.length > 0) {
        await tx.workflowNodeRun.updateMany({
          where: { workspaceId: input.workspaceId, runId: newRunId, nodeId: { in: rootNodeIds }, status: "pending" },
          data: { status: "ready", availableAt: now, updatedAt: now },
        });
      }
      const queued = await tx.workflowRun.updateMany({
        where: { id: newRunId, workspaceId: input.workspaceId, status: "created", currentSequence: 0 },
        data: { status: "queued", currentSequence: 2, updatedAt: now },
      });
      if (queued.count !== 1) throw new Error("workflow_run_materialization_conflict");
      await tx.workflowRunEvent.createMany({
        data: [
          {
            id: `workflow-event-${randomLikeId()}`,
            workspaceId: input.workspaceId,
            runId: newRunId,
            sequence: 1,
            type: "run.created",
            actorType: "scheduler",
            dataJson: { triggerId: input.trigger.id },
            createdAt: now,
          },
          {
            id: `workflow-event-${randomLikeId()}`,
            workspaceId: input.workspaceId,
            runId: newRunId,
            sequence: 2,
            type: "trigger.fired",
            actorType: input.trigger.type === "schedule" ? "scheduler" : "system",
            actorId: input.createdBy ?? null,
            dataJson: {
              triggerId: input.trigger.id,
              scheduledAt: input.scheduledAt,
              nextFireAt: input.triggerAdvance?.nextFireAt ?? null,
              misfirePolicy: input.trigger.misfirePolicy,
              misfired: input.triggerAdvance?.misfired === true,
            },
            createdAt: now,
          },
        ],
      });
      await tx.workflowOutbox.create({
        data: {
          id: `workflow-outbox-${randomLikeId()}`,
          workspaceId: input.workspaceId,
          aggregateType: "workflow_run",
          aggregateId: newRunId,
          eventType: "workflow.run.ready",
          payloadJson: { runId: newRunId },
          status: "pending",
          attempts: 0,
          availableAt: now,
          createdAt: now,
        },
      });
      created = true;
    }

    if (input.triggerAdvance) {
      const advanced = await tx.workflowTrigger.updateMany({
        where: {
          id: input.trigger.id,
          workspaceId: input.workspaceId,
          leaseOwner: input.triggerAdvance.workerId,
        },
        data: {
          nextFireAt: input.triggerAdvance.nextFireAt ? new Date(input.triggerAdvance.nextFireAt) : null,
          lastFireAt: new Date(input.scheduledAt),
          ...(input.triggerAdvance.status ? { status: input.triggerAdvance.status } : {}),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
      if (advanced.count !== 1) throw new Error("workflow_trigger_lease_conflict");
      if (input.triggerAdvance.outcome) {
        await tx.auditLog.create({
          data: {
            id: `audit-${randomLikeId()}`,
            workspaceId: input.workspaceId,
            title: "Workflow trigger outcome",
            note: input.triggerAdvance.outcome.reasonCode,
            code: input.triggerAdvance.outcome.code,
            dataJson: {
              workflowId: input.trigger.workflowId,
              triggerId: input.trigger.id,
              scheduledAt: input.scheduledAt,
              policy: input.trigger.misfirePolicy,
              reasonCode: input.triggerAdvance.outcome.reasonCode,
              occurredAt: input.now,
            },
            createdAt: now,
          },
        });
      }
    }
    return { runId, created };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

function assertTriggerSnapshot(
  claimed: WorkflowTriggerRecord,
  current: {
    workflow_id: string;
    type: string;
    status: string;
    config_json: unknown;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    updated_at: Date;
  } | undefined,
): void {
  if (!current || current.workflow_id !== claimed.workflowId || current.status !== "active") {
    throw new Error("workflow_trigger_not_active");
  }
  if (current.type !== claimed.type) throw new Error("workflow_trigger_stale_snapshot");
  if (claimed.type === "schedule") {
    if (!claimed.leaseOwner
      || current.lease_owner !== claimed.leaseOwner
      || current.lease_expires_at?.toISOString() !== claimed.leaseExpiresAt) {
      throw new Error("workflow_trigger_lease_conflict");
    }
    return;
  }
  if (current.updated_at.toISOString() !== claimed.updatedAt
    || JSON.stringify(current.config_json) !== claimed.configJson) {
    throw new Error("workflow_trigger_stale_snapshot");
  }
}

function parseWorkflowGraph(value: Prisma.JsonValue): WorkflowGraphDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow_graph_invalid");
  const graph = value as unknown as WorkflowGraphDefinition;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error("workflow_graph_invalid");
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !isWorkflowNodeType(node.type) || !node.config || typeof node.config !== "object") {
      throw new Error("workflow_node_type_unsupported");
    }
  }
  return graph;
}

function parseJsonObject(value: string, errorCode: string): Prisma.InputJsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(errorCode);
    return parsed as Prisma.InputJsonObject;
  } catch {
    throw new Error(errorCode);
  }
}

function normalizeJsonObject(value: Prisma.JsonValue, errorCode: string): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Prisma.InputJsonObject;
}

function readMaxAttempts(config: Record<string, unknown>): number {
  const retry = config.retry;
  if (!retry || typeof retry !== "object") return 1;
  const value = (retry as { maxAttempts?: unknown }).maxAttempts;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}
