import {
  createSkillRolloutPlanSync,
  decideSkillRolloutPlanSync,
  getDatabase,
  initializeSkillRolloutReconcileItemsSync,
  listSkillRolloutReconcileItemsSync,
  markSkillRolloutReconcileItemSync,
  readSkillRolloutPlanSync,
} from "@dofe-agent/db";
import {
  computeSkillRolloutTargetRuntimesSync,
  finalizeSkillRolloutPlanSync,
  planSkillRollout,
  type SkillRolloutPersistedPlan,
  type SkillRolloutTargetScope,
} from "./rollout.ts";
import { createSkillInstallationPlanSync } from "./installations.ts";

export interface SkillRolloutDispatchResult {
  planId: string;
  planDigest: string;
  /** The exact planner output bound to the persisted approval record. */
  plan: SkillRolloutPersistedPlan;
  totalItems: number;
  requiredCount: number;
  createdCount: number;
  reusedCount: number;
  createdInstallations: Array<{
    runtimeId: string;
    artifactDigest: string;
    installationId: string;
    revision: string;
  }>;
}

export interface SkillRolloutReconcileResult {
  planId: string;
  planDigest: string;
  createdInstallations: SkillRolloutDispatchResult["createdInstallations"];
  reusedCount: number;
  items: ReturnType<typeof listSkillRolloutReconcileItemsSync>;
  consumed: boolean;
}

/** Recoverable context for a partially dispatched rollout. */
export class SkillRolloutDispatchError extends Error {
  readonly planId: string;
  readonly planDigest: string;
  readonly createdInstallations: SkillRolloutDispatchResult["createdInstallations"];

  constructor(input: {
    planId: string;
    planDigest: string;
    createdInstallations: SkillRolloutDispatchResult["createdInstallations"];
    cause?: unknown;
  }) {
    super(`Skill rollout dispatch failed for plan "${input.planId}".`, { cause: input.cause });
    this.name = "SkillRolloutDispatchError";
    this.planId = input.planId;
    this.planDigest = input.planDigest;
    this.createdInstallations = input.createdInstallations;
  }
}

/** Re-enters a pending/failed plan and records every item transition durably. */
export function reconcileSkillRolloutPlanSync(input: {
  planId: string;
  workspaceId?: string;
  requestedByUserId?: string;
}): SkillRolloutReconcileResult {
  const workspaceId = input.workspaceId ?? "default";
  const planRecord = readSkillRolloutPlanSync(input.planId, workspaceId);
  if (!planRecord) throw new Error("skill_rollout_plan_not_found");
  if (planRecord.decision !== "approved") throw new Error("skill_rollout_plan_not_approved");
  let items = listSkillRolloutReconcileItemsSync(input.planId, workspaceId);
  if (items.length === 0) throw new Error("skill_rollout_reconcile_items_missing");
  const createdInstallations: SkillRolloutDispatchResult["createdInstallations"] = [];
  const reusedCount = items.filter((item) => item.status === "created").length;

  for (const item of items) {
    if (item.status === "created") continue;
    try {
      const runtime = getDatabase().prepare(
        `SELECT workspace_id AS "workspaceId", status FROM agent_runtime WHERE id = ?`,
      ).get(item.runtimeId) as { workspaceId?: string; status?: string } | undefined;
      if (!runtime || runtime.workspaceId !== workspaceId) {
        throw new Error(`runtime_not_found:${item.runtimeId}`);
      }
      if (runtime.status !== "online") {
        throw new Error(`runtime_not_online:${item.runtimeId}`);
      }
      const installation = createSkillInstallationPlanSync({
        workspaceId,
        runtimeId: item.runtimeId,
        artifactDigest: item.artifactDigest,
        rolloutPlanId: input.planId,
        requestedByUserId: input.requestedByUserId,
      });
      markSkillRolloutReconcileItemSync({
        id: item.id,
        workspaceId,
        status: "created",
        installationId: installation.id,
        revision: installation.revision,
      });
      createdInstallations.push({
        runtimeId: item.runtimeId,
        artifactDigest: item.artifactDigest,
        installationId: installation.id,
        revision: installation.revision,
      });
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "skill_rollout_reconcile_failed";
      markSkillRolloutReconcileItemSync({ id: item.id, workspaceId, status: "failed", errorCode });
      throw new SkillRolloutDispatchError({
        planId: input.planId,
        planDigest: planRecord.planDigest,
        createdInstallations,
        cause: error,
      });
    }
  }

  items = listSkillRolloutReconcileItemsSync(input.planId, workspaceId);
  const finalized = items.length > 0 && items.every((item) => item.status === "created")
    && finalizeSkillRolloutPlanSync(input.planId, workspaceId);
  // Another worker may consume the same plan between our read and finalize.
  // Re-read the row so concurrent idempotent retries converge on success.
  const consumed = items.length > 0 && items.every((item) => item.status === "created")
    && (Boolean(planRecord.consumedAt) || finalized || Boolean(readSkillRolloutPlanSync(input.planId, workspaceId)?.consumedAt));
  if (!consumed) {
    throw new SkillRolloutDispatchError({
      planId: input.planId,
      planDigest: planRecord.planDigest,
      createdInstallations,
      cause: new Error("Rollout plan could not be consumed after reconcile."),
    });
  }
  return { planId: input.planId, planDigest: planRecord.planDigest, createdInstallations, reusedCount, items, consumed };
}

/**
 * G1 orchestration loop: one operation installs a root skill and its full
 * dependency closure onto the target runtimes.
 *
 *   1. planSkillRollout — resolve closure + placement-aware items + planDigest.
 *   2. createSkillRolloutPlanSync — persist a pending rollout plan.
 *   3. decideSkillRolloutPlanSync — approve (one approval covers the whole rollout).
 *   4. createSkillInstallationPlanSync — dispatch each pending (runtime × artifact) item.
 *   5. finalizeSkillRolloutPlanSync — consume the plan (replay guard).
 */
export function installSkillRolloutSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  targetScope: SkillRolloutTargetScope;
  dependencyMode?: "required-only" | "include-optional";
  /** Auto-approve the plan (one-operation UX). Default true. */
  approve?: boolean;
  requestedByUserId?: string;
}): SkillRolloutDispatchResult {
  const workspaceId = input.workspaceId ?? "default";
  const approve = input.approve ?? true;

  const plan = planSkillRollout({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    targetScope: input.targetScope,
    dependencyMode: input.dependencyMode,
  });

  const targetRuntimes = computeSkillRolloutTargetRuntimesSync(input.targetScope, workspaceId);
  const planRecord = createSkillRolloutPlanSync({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    planDigest: plan.planDigest,
    closureJson: JSON.stringify(plan.closure),
    targetRuntimesJson: JSON.stringify(targetRuntimes),
    riskSummaryJson: JSON.stringify(plan.risks),
  });
  initializeSkillRolloutReconcileItemsSync({
    workspaceId,
    planId: planRecord.id,
    items: plan.items.map((item) => ({
      runtimeId: item.runtimeId,
      artifactDigest: item.artifactDigest,
      status: item.state === "pending" ? "pending" : "created",
      revision: item.state === "pending" ? undefined : item.revision,
    })),
  });

  if (!approve) {
    return {
      planId: planRecord.id,
      planDigest: plan.planDigest,
      plan: { ...plan, planId: planRecord.id },
      totalItems: plan.items.length,
      requiredCount: plan.requiredCount,
      createdCount: 0,
      reusedCount: 0,
      createdInstallations: [],
    };
  }

  const approved = decideSkillRolloutPlanSync(planRecord.id, workspaceId, "approved");
  if (!approved) {
    throw new Error("Rollout plan 无法批准（可能已决定或不存在）。");
  }

  try {
    const reconciled = reconcileSkillRolloutPlanSync({
      planId: planRecord.id,
      workspaceId,
      requestedByUserId: input.requestedByUserId,
    });
    return {
      planId: planRecord.id,
      planDigest: plan.planDigest,
      plan: { ...plan, planId: planRecord.id },
      totalItems: plan.items.length,
      requiredCount: plan.requiredCount,
      createdCount: reconciled.createdInstallations.length,
      reusedCount: reconciled.reusedCount,
      createdInstallations: reconciled.createdInstallations,
    };
  } catch (error) {
    if (error instanceof SkillRolloutDispatchError) throw error;
    throw new SkillRolloutDispatchError({ planId: planRecord.id, planDigest: plan.planDigest, createdInstallations: [], cause: error });
  }
}
