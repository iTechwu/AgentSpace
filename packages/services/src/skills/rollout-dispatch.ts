import {
  createSkillRolloutPlanSync,
  decideSkillRolloutPlanSync,
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

  const createdInstallations: SkillRolloutDispatchResult["createdInstallations"] = [];
  let reusedCount = 0;
  for (const item of plan.items) {
    if (item.state !== "pending") {
      reusedCount += 1;
      continue;
    }
    const installation = createSkillInstallationPlanSync({
      workspaceId,
      runtimeId: item.runtimeId,
      artifactDigest: item.artifactDigest,
      rolloutPlanId: planRecord.id,
      requestedByUserId: input.requestedByUserId,
    });
    createdInstallations.push({
      runtimeId: item.runtimeId,
      artifactDigest: item.artifactDigest,
      installationId: installation.id,
      revision: installation.revision,
    });
  }

  finalizeSkillRolloutPlanSync(planRecord.id, workspaceId);

  return {
    planId: planRecord.id,
    planDigest: plan.planDigest,
    plan: { ...plan, planId: planRecord.id },
    totalItems: plan.items.length,
    requiredCount: plan.requiredCount,
    createdCount: createdInstallations.length,
    reusedCount,
    createdInstallations,
  };
}
