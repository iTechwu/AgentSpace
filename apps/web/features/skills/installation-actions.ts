"use server";

import { createHash, randomBytes } from "node:crypto";
import {
  listInstallableRuntimesForWorkspaceSync,
  listSkillInstallApprovalsSync,
  listSkillArtifactsForSkillSync,
  listSkillRunnerInvocationsSync,
  listSkillInstallationOperationsSync,
  listSkillInstallationsSync,
  listManagedSkillServicesSync,
  listSkillServiceBindingsForServiceSync,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationSync,
  readSkillServiceCatalogSync,
} from "@dofe-agent/db";
import {
  approveSkillInstallSync,
  approveSkillUpgradeCandidateSync,
  approveSkillUpgradeSync,
  buildSkillInstallRiskItemsSync,
  buildSkillInstallationComponentsSync,
  computeSkillInstallRiskDecisionDigestSync,
  computeSkillReleaseLockSync,
  computeSkillUpgradeDiffHashSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  diffSkillArtifactsSync,
  listSkillUpgradeReviewCandidatesSync,
  promoteSkillUpgradeSync,
  rollbackSkillInstallationSync,
  tryRecordWorkspaceAuditEventSync,
  uninstallSkillInstallationSync,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  infoToast,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";
import { buildSkillInstallationDiagnostics } from "@/features/skills/skill-installation-diagnostics";

/**
 * Skill installation Server Actions (Phase 5 UI plumbing). These wrap the
 * installation control plane so the Skill Library wizard + detail pages have a
 * typed API surface. The daemon executes operations via the REST
 * `/api/daemon/.../skill-operations/*` routes; the control plane never edits a
 * runtime directly.
 */

export interface SkillInstallableRuntime {
  id: string;
  name: string;
  provider: string;
  status: string;
  provisioningState?: string;
}

export interface SkillInstallationInspectionView {
  artifact: {
    name: string;
    version: string;
    digest: string;
    sourceType: string;
    fileCount: number;
    totalSizeBytes: number;
  };
  files: Array<{ path: string; sizeBytes: number; mediaType: string; mode: string }>;
  dependencies: Array<{ kind: string; name: string; version: string; integrity?: string }>;
  capabilities: Array<{ kind: string; catalogSlug: string; requiredTools: string[] }>;
  services: Array<{ catalogSlug: string; templateVersion: string; required: boolean }>;
  entrypoints: Array<{ id: string; path: string; runtime: string }>;
  components: Array<{ kind: string; key: string }>;
  releaseLockDigest: string;
  unresolvedRequired: string[];
  /** Explicit high-risk capability items the admin must authorize one-by-one (P0-2). */
  riskItems: Array<{ category: "script" | "network" | "mcp_tool" | "write"; key: string; description: string }>;
  /** sha256 of the canonical risk decision — binds an approval to this artifact/lock/risk set. */
  riskDecisionDigest: string;
}

export async function inspectSkillInstallationAction(input: {
  skillId: string;
}): Promise<SkillInstallationInspectionView> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");

  const digest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!digest) {
    throw new Error("此 Skill 尚无不可变 artifact，请先重新导入以生成 artifact。");
  }
  const artifact = readSkillArtifactByDigestSync(digest, workspaceContext.currentWorkspace.id);
  if (!artifact) {
    throw new Error("Skill artifact 不存在或不属于当前工作区。");
  }
  const manifest = parseInspectionManifest(artifact.manifestJson);
  const releaseLock = computeSkillReleaseLockSync(artifact, workspaceContext.currentWorkspace.id);
  const riskItems = buildSkillInstallRiskItemsSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    artifactDigest: artifact.digest,
  });
  const riskDecisionDigest = computeSkillInstallRiskDecisionDigestSync({
    artifactDigest: artifact.digest,
    releaseLockDigest: releaseLock.lockDigest,
    riskItems,
  });
  return {
    artifact: {
      name: artifact.name,
      version: artifact.version,
      digest: artifact.digest,
      sourceType: artifact.sourceType,
      fileCount: artifact.fileCount,
      totalSizeBytes: artifact.totalSizeBytes,
    },
    files: readSkillArtifactFilesSync(artifact.id).map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
      mode: file.mode,
    })),
    dependencies: manifest.dependencies ?? [],
    capabilities: (manifest.capabilities ?? []).map((capability) => ({
      ...capability,
      requiredTools: capability.requiredTools ?? [],
    })),
    services: manifest.services ?? [],
    entrypoints: manifest.entrypoints ?? [],
    components: buildSkillInstallationComponentsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      artifactDigest: artifact.digest,
    }).map((component) => ({ kind: component.kind, key: component.key })),
    releaseLockDigest: releaseLock.lockDigest,
    unresolvedRequired: releaseLock.unresolvedRequired,
    riskItems,
    riskDecisionDigest,
  };
}

export type SkillInstallationWizardLoadResult =
  | { ok: true; inspection: SkillInstallationInspectionView; runtimes: SkillInstallableRuntime[] }
  | { ok: false; code: "artifact_missing" | "inspection_failed" };

/** Loads wizard prerequisites together and represents expected preflight failures without a 500 response. */
export async function loadSkillInstallationWizardAction(input: {
  skillId: string;
}): Promise<SkillInstallationWizardLoadResult> {
  try {
    const [inspection, runtimes] = await Promise.all([
      inspectSkillInstallationAction(input),
      listSkillInstallableRuntimesAction(),
    ]);
    return { ok: true, inspection, runtimes };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const artifactMissing = message.includes("尚无不可变 artifact")
      || message.includes("artifact 不存在或不属于当前工作区");
    return { ok: false, code: artifactMissing ? "artifact_missing" : "inspection_failed" };
  }
}

/** Runtimes available for skill installation in the current workspace. */
export async function listSkillInstallableRuntimesAction(): Promise<SkillInstallableRuntime[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return listInstallableRuntimesForWorkspaceSync(workspaceContext.currentWorkspace.id);
}

export interface SkillServiceResolutionOption {
  catalogSlug: string;
  templateVersion: string;
  required: boolean;
  reusable: boolean;
  status?: string;
  health?: string;
}

export async function listSkillServiceResolutionOptionsAction(input: {
  skillId: string;
  runtimeId: string;
}): Promise<SkillServiceResolutionOption[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.runtimeId, "runtime id");
  const workspaceId = workspaceContext.currentWorkspace.id;
  const digest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceId);
  const artifact = digest ? readSkillArtifactByDigestSync(digest, workspaceId) : null;
  if (!artifact) return [];
  const managedServices = listManagedSkillServicesSync(workspaceId);

  return (parseInspectionManifest(artifact.manifestJson).services ?? []).map((service) => {
    const catalog = readSkillServiceCatalogSync(service.catalogSlug, service.templateVersion, workspaceId);
    const managed = catalog
      ? managedServices.find((candidate) => candidate.runtimeId === input.runtimeId.trim() && candidate.catalogId === catalog.id)
      : undefined;
    const hasPrivateEndpoint = managed
      ? listSkillServiceBindingsForServiceSync(managed.id).some((binding) => binding.endpointRef.startsWith("runtime-private://"))
      : false;
    return {
      catalogSlug: service.catalogSlug,
      templateVersion: service.templateVersion,
      required: service.required,
      reusable: managed?.status === "ready" && managed.lastHealth === "healthy" && hasPrivateEndpoint,
      status: managed?.status,
      health: managed?.lastHealth,
    };
  });
}

export async function createSkillInstallationAction(input: {
  skillId: string;
  runtimeId: string;
  serviceResolutionMode?: "provision_or_reuse" | "require_existing";
  /**
   * Immutable per-item risk approval obtained via `approveSkillInstallAction`.
   * Required when the artifact declares any script/network/high-risk-MCP/write
   * capability (first-install risk gate, P0-2).
   */
  approvalId?: string;
}): Promise<ActionToastResult<{ installationId: string; status: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.runtimeId, "runtime id");

  const digest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!digest) {
    throw new Error("此 Skill 尚无不可变 artifact，请先重新导入以生成 artifact。");
  }

  const installation = createSkillInstallationPlanSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    artifactDigest: digest,
    requestedByUserId: workspaceContext.currentUser.id,
    approvalId: input.approvalId?.trim() || undefined,
    serviceResolutionMode: input.serviceResolutionMode,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill installation planned",
    note: `Installation plan for skill "${input.skillId}" (${digest.slice(0, 12)}…) on runtime "${input.runtimeId}" created by ${workspaceContext.currentUser.displayName}.`,
    code: "skill_installation.planned",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: installation.id,
      skillId: input.skillId.trim(),
      runtimeId: input.runtimeId.trim(),
      artifactDigest: digest,
      serviceResolutionMode: input.serviceResolutionMode ?? "provision_or_reuse",
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    { installationId: installation.id, status: installation.status },
    infoToast("安装计划已创建，daemon 将在目标 Runtime 上准备环境。", "Installation plan created; the daemon will prepare on the target runtime."),
  );
}

export async function approveSkillInstallAction(input: {
  skillId: string;
  reason: string;
}): Promise<{ approvalId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");

  const digest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!digest) {
    throw new Error("此 Skill 尚无不可变 artifact，请先重新导入以生成 artifact。");
  }
  const artifact = readSkillArtifactByDigestSync(digest, workspaceContext.currentWorkspace.id);
  if (!artifact) {
    throw new Error("Skill artifact 不存在或不属于当前工作区。");
  }
  const riskItems = buildSkillInstallRiskItemsSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    artifactDigest: digest,
  });
  const lock = computeSkillReleaseLockSync(artifact, workspaceContext.currentWorkspace.id);
  const { approvalId } = approveSkillInstallSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
    artifactDigest: digest,
    releaseLockDigest: lock.lockDigest,
    riskItems,
    reason: input.reason.trim() || "管理员逐项审批授权",
    actorUserId: workspaceContext.currentUser.id,
  });
  return { approvalId };
}

export interface SkillInstallApprovalAuditView {
  id: string;
  skillId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  policyVersion: string;
  riskDecisionDigest: string;
  decision: string;
  riskItems: Array<{ category: string; key: string; description: string }>;
  reason?: string;
  createdAt: string;
  consumedAt?: string;
}

export async function listSkillInstallApprovalsAction(): Promise<SkillInstallApprovalAuditView[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return listSkillInstallApprovalsSync(workspaceContext.currentWorkspace.id).map((approval) => ({
    id: approval.id,
    skillId: approval.skillId,
    artifactDigest: approval.artifactDigest,
    releaseLockDigest: approval.releaseLockDigest,
    policyVersion: approval.policyVersion,
    riskDecisionDigest: approval.riskDecisionDigest,
    decision: approval.decision,
    riskItems: approval.riskItems,
    reason: approval.reason,
    createdAt: approval.createdAt,
    consumedAt: approval.consumedAt,
  }));
}

export interface SkillRunnerInvocationAuditView {
  id: string;
  taskId?: string;
  runtimeId?: string;
  installationId?: string;
  skillId?: string;
  skillName: string;
  artifactDigest: string;
  entrypointKey: string;
  entrypointPath?: string;
  entrypointRuntime?: string;
  actorId: string;
  resultCode: number;
  timedOut: boolean;
  durationMs?: number;
  safeSummary?: string;
  createdAt: string;
}

export async function listSkillRunnerInvocationsAction(limit = 20): Promise<SkillRunnerInvocationAuditView[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return listSkillRunnerInvocationsSync({ workspaceId: workspaceContext.currentWorkspace.id, limit }).map(
    (invocation) => ({
      id: invocation.id,
      taskId: invocation.taskId,
      runtimeId: invocation.runtimeId,
      installationId: invocation.installationId,
      skillId: invocation.skillId,
      skillName: invocation.skillName,
      artifactDigest: invocation.artifactDigest,
      entrypointKey: invocation.entrypointKey,
      entrypointPath: invocation.entrypointPath,
      entrypointRuntime: invocation.entrypointRuntime,
      actorId: invocation.actorId,
      resultCode: invocation.resultCode,
      timedOut: invocation.timedOut,
      durationMs: invocation.durationMs,
      safeSummary: invocation.safeSummary,
      createdAt: invocation.createdAt,
    }),
  );
}

export interface UpgradeReviewCandidateView {
  skillId: string;
  skillName: string;
  runtimeId: string;
  previousInstallationId: string;
  previousArtifactDigest: string;
  previousRevision: string;
  candidateArtifactDigest: string;
  breaking: boolean;
  changeCount: number;
  diffCategories: Array<{ category: string; breaking: boolean; changes: string[] }>;
  newRiskItems: Array<{ category: string; key: string; description: string }>;
}

/** Workspace-wide upgrade approval inbox (P1-3). */
export async function listUpgradeReviewCandidatesAction(): Promise<UpgradeReviewCandidateView[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return listSkillUpgradeReviewCandidatesSync(workspaceContext.currentWorkspace.id).map((candidate) => ({
    skillId: candidate.skillId,
    skillName: candidate.skillName,
    runtimeId: candidate.runtimeId,
    previousInstallationId: candidate.previousInstallationId,
    previousArtifactDigest: candidate.previousArtifactDigest,
    previousRevision: candidate.previousRevision,
    candidateArtifactDigest: candidate.candidateArtifactDigest,
    breaking: candidate.breaking,
    changeCount: candidate.changeCount,
    diffCategories: candidate.diffCategories,
    newRiskItems: candidate.newRiskItems,
  }));
}

export async function reviewUpgradeCandidateAction(input: {
  skillId: string;
  runtimeId: string;
  previousInstallationId: string;
  decision: "approved" | "rejected";
  reason: string;
}): Promise<ActionToastResult<{ installationId?: string; breaking: boolean; newRiskCount: number }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const result = approveSkillUpgradeCandidateSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
    runtimeId: input.runtimeId.trim(),
    previousInstallationId: input.previousInstallationId.trim(),
    decision: input.decision,
    reason: input.reason.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: input.decision === "approved" ? "Skill upgrade approved" : "Skill upgrade rejected",
    note: `${input.decision === "approved" ? "Approved" : "Rejected"} upgrade for skill "${input.skillId}" by ${workspaceContext.currentUser.displayName} (breaking=${result.breaking}, new risks=${result.newRiskCount}).`,
    code: input.decision === "approved" ? "skill_installation.upgrade_approved" : "skill_installation.upgrade_rejected",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: result.installationId ?? "",
      skillId: input.skillId.trim(),
      runtimeId: input.runtimeId.trim(),
      breaking: String(result.breaking),
      newRiskCount: String(result.newRiskCount),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    result,
    input.decision === "approved"
      ? infoToast("升级候选已批准，计划已创建。", "Upgrade candidate approved; plan created.")
      : infoToast("升级候选已驳回，已记录审批。", "Upgrade candidate rejected; approval recorded."),
  );
}

export async function createSkillUpgradeAction(input: {
  skillId: string;
  runtimeId: string;
  previousInstallationId: string;
  candidateArtifactDigest?: string;
  approved?: boolean;
  /** True when the admin authorizes high-risk capabilities newly introduced by the candidate. */
  approvedRisks?: boolean;
}): Promise<ActionToastResult<{ installationId: string; breaking: boolean; changeCount: number }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.runtimeId, "runtime id");
  assertRequired(input.previousInstallationId, "previous installation id");

  const activeDigest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!activeDigest) {
    throw new Error("此 Skill 尚无 artifact。");
  }
  const candidateDigest = input.candidateArtifactDigest?.trim()
    || listSkillArtifactsForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id)
      .find((artifact) => artifact.digest !== activeDigest)?.digest;
  if (!candidateDigest) {
    throw new Error("此 Skill 尚无待发布的候选 artifact，请先重新导入新版本。");
  }

  // Surface the semantic diff so the caller can require re-approval for
  // breaking changes (executable / capability / service / config). A breaking
  // upgrade records an IMMUTABLE approval bound to (fromDigest, toDigest,
  // diffHash, policyVersion) instead of a one-shot boolean.
  const previous = readSkillInstallationSync(input.previousInstallationId.trim(), workspaceContext.currentWorkspace.id);
  let breaking = false;
  let changeCount = 0;
  let approvalId: string | undefined;
  let installApprovalId: string | undefined;
  if (previous) {
    if (previous.artifactDigest !== activeDigest) {
      throw new Error("上一个安装版本与当前 active artifact 不一致，请刷新后重试。");
    }
    const previousArtifact = readSkillArtifactByDigestSync(previous.artifactDigest, workspaceContext.currentWorkspace.id);
    const nextArtifact = readSkillArtifactByDigestSync(candidateDigest, workspaceContext.currentWorkspace.id);
    if (previousArtifact && nextArtifact) {
      const diff = diffSkillArtifactsSync({
        fromManifestJson: previousArtifact.manifestJson,
        toManifestJson: nextArtifact.manifestJson,
      });
      breaking = diff.breaking;
      changeCount = diff.categories.reduce((count, category) => count + category.changes.length, 0);

      // Risk re-review (P0-2 收尾): a candidate introducing high-risk capability
      // items the previous version did not have requires a fresh per-item approval.
      const previousRiskKeys = new Set(
        buildSkillInstallRiskItemsSync({
          workspaceId: workspaceContext.currentWorkspace.id,
          artifactDigest: previousArtifact.digest,
        }).map((item) => item.key),
      );
      const candidateRiskItems = buildSkillInstallRiskItemsSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        artifactDigest: candidateDigest,
      });
      const newRiskItems = candidateRiskItems.filter((item) => !previousRiskKeys.has(item.key));
      if (newRiskItems.length > 0) {
        if (input.approvedRisks !== true) {
          throw new Error(`升级引入了 ${newRiskItems.length} 项新的高风险能力，需要逐项授权后才能升级。`);
        }
        const candidateLock = computeSkillReleaseLockSync(nextArtifact, workspaceContext.currentWorkspace.id);
        installApprovalId = approveSkillInstallSync({
          workspaceId: workspaceContext.currentWorkspace.id,
          skillId: input.skillId.trim(),
          artifactDigest: candidateDigest,
          releaseLockDigest: candidateLock.lockDigest,
          riskItems: candidateRiskItems,
          reason: `Admin authorized ${newRiskItems.length} new high-risk capability item(s) in the upgrade flow.`,
          actorUserId: workspaceContext.currentUser.id,
        }).approvalId;
      }
    }
    if (breaking) {
      if (input.approved !== true) {
        throw new Error("升级包含 breaking 变更，需要显式批准。");
      }
      const diffHash = computeSkillUpgradeDiffHashSync({
        fromManifestJson: previousArtifact?.manifestJson ?? "{}",
        toManifestJson: nextArtifact?.manifestJson ?? "{}",
      });
      approvalId = approveSkillUpgradeSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        skillId: input.skillId.trim(),
        fromDigest: previous.artifactDigest,
        toDigest: candidateDigest,
        diffHash,
        decision: "approved",
        reason: "Approved by admin in the skill-installation upgrade flow.",
        actorUserId: workspaceContext.currentUser.id,
      }).approvalId;
    }
  }

  const installation = createSkillUpgradePlanSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    artifactDigest: candidateDigest,
    previousReadyInstallationId: input.previousInstallationId.trim(),
    requestedByUserId: workspaceContext.currentUser.id,
    ...(approvalId ? { approvalId } : {}),
    ...(installApprovalId ? { installApprovalId } : {}),
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill upgrade planned",
    note: `Upgrade for skill "${input.skillId}" (${candidateDigest.slice(0, 12)}…) planned by ${workspaceContext.currentUser.displayName} (breaking=${breaking}, changes=${changeCount}).`,
    code: "skill_installation.upgrade_planned",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: installation.id,
      skillId: input.skillId.trim(),
      runtimeId: input.runtimeId.trim(),
      artifactDigest: candidateDigest,
      breaking,
      changeCount,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    { installationId: installation.id, breaking, changeCount },
    infoToast(`升级计划已创建（${changeCount} 项变更${breaking ? "，需重新批准" : ""}）。`, `Upgrade planned (${changeCount} changes${breaking ? ", re-approval required" : ""}).`),
  );
}

export async function promoteSkillUpgradeAction(input: {
  installationId: string;
  skillId: string;
  expectedPreviousDigest: string;
}): Promise<ActionToastResult<{ artifactDigest: string; revision: string; assignmentCount: number }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.installationId, "installation id");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.expectedPreviousDigest, "expected previous digest");
  const promoted = promoteSkillUpgradeSync({
    installationId: input.installationId.trim(),
    skillId: input.skillId.trim(),
    expectedPreviousDigest: input.expectedPreviousDigest.trim(),
    workspaceId: workspaceContext.currentWorkspace.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill upgrade promoted",
    note: `Installation "${input.installationId}" promoted to ${promoted.artifactDigest.slice(0, 12)} by ${workspaceContext.currentUser.displayName}.`,
    code: "skill_installation.upgrade_promoted",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: input.installationId.trim(),
      skillId: input.skillId.trim(),
      artifactDigest: promoted.artifactDigest,
      revision: promoted.revision,
      assignmentCount: promoted.assignmentCount,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    promoted,
    successToast("候选版本已发布，新任务将使用该版本。", "Candidate promoted; new tasks will use this revision."),
  );
}

export async function rollbackSkillInstallationAction(input: {
  installationId: string;
}): Promise<ActionToastResult<{ previousReadyDigest?: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.installationId, "installation id");

  const result = rollbackSkillInstallationSync({
    installationId: input.installationId.trim(),
    workspaceId: workspaceContext.currentWorkspace.id,
  });
  if (!result.ok) {
    throw new Error(result.reason ?? "回滚失败。");
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill installation rolled back",
    note: `Installation "${input.installationId}" rolled back to ${result.previousReadyDigest?.slice(0, 12) ?? "previous"} by ${workspaceContext.currentUser.displayName}.`,
    code: "skill_installation.rolled_back",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: input.installationId.trim(),
      artifactDigest: result.previousReadyDigest,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    { previousReadyDigest: result.previousReadyDigest },
    successToast("已回滚到上一个 ready 版本。", "Rolled back to the previous ready revision."),
  );
}

export interface SkillInstallationRowView {
  installationId: string;
  runtimeId: string;
  artifactDigest: string;
  status: string;
  revision: string;
  previousReadyRevision?: string;
  previousReadyArtifactDigest?: string;
  candidateArtifactDigest?: string;
  candidateBreaking?: boolean;
  candidateChangeCount?: number;
  /** High-risk capability items the candidate introduces that the active version lacks. */
  candidateNewRiskItems?: Array<{ category: string; key: string; description: string }>;
  active: boolean;
  releaseLockDigest?: string;
  preparedDigest?: string;
  health: string;
  createdAt: string;
  components: Array<{ kind: string; key: string; status: string; errorCode?: string; errorMessage?: string }>;
  operations: Array<{
    id: string;
    operation: string;
    status: string;
    claimGeneration: number;
    errorMessage?: string;
    evidence?: { computedDigest?: string; cacheHit?: boolean; installedDependencyCount?: number };
  }>;
}

export async function listSkillInstallationRowsForSkillAction(input: {
  skillId: string;
}): Promise<SkillInstallationRowView[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");

  const artifacts = listSkillArtifactsForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  const activeDigest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  const digests = new Set(artifacts.map((artifact) => artifact.digest));
  const rows: SkillInstallationRowView[] = [];
  for (const digest of digests) {
    for (const installation of listSkillInstallationsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      artifactDigest: digest,
      limit: 50,
    })) {
      rows.push({
        installationId: installation.id,
        runtimeId: installation.runtimeId,
        artifactDigest: installation.artifactDigest,
        status: installation.status,
        revision: installation.revision,
        previousReadyRevision: installation.previousReadyRevision,
        previousReadyArtifactDigest: installation.previousReadyArtifactDigest,
        active: installation.artifactDigest === activeDigest,
        releaseLockDigest: readReleaseLockDigest(installation.resolvedLockJson),
        preparedDigest: installation.preparedDigest,
        health: installation.health,
        createdAt: installation.createdAt,
        components: readSkillInstallationComponentsSync(installation.id).map((component) => ({
          kind: component.kind,
          key: component.key,
          status: component.status,
          errorCode: component.errorCode,
          errorMessage: component.errorMessage,
        })),
        operations: listSkillInstallationOperationsSync({
          workspaceId: workspaceContext.currentWorkspace.id,
          installationId: installation.id,
          limit: 10,
        }).map((operation) => ({
          id: operation.id,
          operation: operation.operation,
          status: operation.status,
          claimGeneration: operation.claimGeneration,
          errorMessage: operation.errorMessage,
          evidence: readOperationEvidence(operation.safeResultJson),
        })),
      });
    }
  }
  const candidateArtifact = artifacts.find((artifact) => artifact.digest !== activeDigest);
  const activeArtifact = activeDigest
    ? artifacts.find((artifact) => artifact.digest === activeDigest)
    : undefined;
  if (candidateArtifact && activeArtifact) {
    const diff = diffSkillArtifactsSync({
      fromManifestJson: activeArtifact.manifestJson,
      toManifestJson: candidateArtifact.manifestJson,
    });
    const changeCount = diff.categories.reduce((count, category) => count + category.changes.length, 0);
    const activeRiskKeys = new Set(
      buildSkillInstallRiskItemsSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        artifactDigest: activeArtifact.digest,
      }).map((item) => item.key),
    );
    const candidateRiskItems = buildSkillInstallRiskItemsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      artifactDigest: candidateArtifact.digest,
    });
    const candidateNewRiskItems = candidateRiskItems.filter((item) => !activeRiskKeys.has(item.key));
    for (const row of rows) {
      const candidateAlreadyPlanned = rows.some((candidateRow) => (
        candidateRow.runtimeId === row.runtimeId
        && candidateRow.artifactDigest === candidateArtifact.digest
        && candidateRow.status !== "retired"
      ));
      if (row.active && row.status === "ready" && !candidateAlreadyPlanned) {
        row.candidateArtifactDigest = candidateArtifact.digest;
        row.candidateBreaking = diff.breaking;
        row.candidateChangeCount = changeCount;
        row.candidateNewRiskItems = candidateNewRiskItems.length > 0 ? candidateNewRiskItems : undefined;
      }
    }
  }
  rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return rows;
}

export interface SkillInstallationPanelView {
  rows: SkillInstallationRowView[];
  approvals: SkillInstallApprovalAuditView[];
  invocations: SkillRunnerInvocationAuditView[];
}

/** Loads the installation panel in one server-action round trip. */
export async function loadSkillInstallationPanelAction(input: {
  skillId: string;
}): Promise<SkillInstallationPanelView> {
  assertRequired(input.skillId, "skill id");
  const skillId = input.skillId.trim();
  const [rows, approvals, invocations] = await Promise.all([
    listSkillInstallationRowsForSkillAction({ skillId }),
    listSkillInstallApprovalsAction(),
    listSkillRunnerInvocationsAction(),
  ]);
  const installationIds = new Set(rows.map((row) => row.installationId));

  return {
    rows,
    approvals: approvals.filter((approval) => approval.skillId === skillId),
    invocations: invocations.filter((invocation) => (
      invocation.installationId !== undefined && installationIds.has(invocation.installationId)
    )),
  };
}

export async function downloadSkillInstallationDiagnosticsAction(input: {
  skillId: string;
}): Promise<ActionToastResult<{ fileName: string; contentBase64: string; sha256: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  const skillId = input.skillId.trim();
  const workspaceId = workspaceContext.currentWorkspace.id;
  const artifacts = listSkillArtifactsForSkillSync(skillId, workspaceId);
  if (artifacts.length === 0) {
    throw new Error("此 Skill 尚无可导出的安装诊断数据。");
  }
  const installations = artifacts.flatMap((artifact) => listSkillInstallationsSync({
    workspaceId,
    artifactDigest: artifact.digest,
    limit: 100,
  }));
  const bundle = buildSkillInstallationDiagnostics({
    generatedAt: new Date().toISOString(),
    referenceSalt: randomBytes(32),
    workspaceId,
    skillId,
    artifacts: artifacts.map((artifact) => ({
      digest: artifact.digest,
      version: artifact.version,
      sourceType: artifact.sourceType,
      fileCount: artifact.fileCount,
      totalSizeBytes: artifact.totalSizeBytes,
    })),
    installations: installations.map((installation) => ({
      id: installation.id,
      runtimeId: installation.runtimeId,
      artifactDigest: installation.artifactDigest,
      status: installation.status,
      revision: installation.revision,
      health: installation.health,
      releaseLockDigest: readReleaseLockDigest(installation.resolvedLockJson),
      preparedDigest: installation.preparedDigest,
      createdAt: installation.createdAt,
      components: readSkillInstallationComponentsSync(installation.id),
      operations: listSkillInstallationOperationsSync({
        workspaceId,
        installationId: installation.id,
        limit: 50,
      }).map((operation) => ({
        id: operation.id,
        operation: operation.operation,
        status: operation.status,
        claimGeneration: operation.claimGeneration,
        errorCode: operation.errorCode,
        errorMessage: operation.errorMessage,
        createdAt: operation.createdAt,
        evidence: readOperationEvidence(operation.safeResultJson),
      })),
    })),
    approvals: listSkillInstallApprovalsSync(workspaceId).filter((approval) => approval.skillId === skillId),
    invocations: listSkillRunnerInvocationsSync({ workspaceId, skillId, limit: 100 }),
  });
  const content = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Skill installation diagnostics exported",
    note: `Redacted installation diagnostics for skill "${skillId}" were exported by ${workspaceContext.currentUser.displayName}.`,
    code: "skill_installation.diagnostics_exported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: skillId,
      artifactCount: artifacts.length,
      installationCount: installations.length,
      sha256,
    },
  });

  return actionToastResult({
    fileName: `skill-installation-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    contentBase64: content.toString("base64"),
    sha256,
  }, successToast("脱敏诊断包已生成。", "Redacted diagnostics generated."));
}

export async function readSkillInstallationDetailAction(input: {
  installationId: string;
}): Promise<SkillInstallationRowView> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.installationId, "installation id");

  const installation = readSkillInstallationSync(input.installationId.trim(), workspaceContext.currentWorkspace.id);
  if (!installation) {
    throw new Error(`安装 ${input.installationId} 不存在。`);
  }
  return {
    installationId: installation.id,
    runtimeId: installation.runtimeId,
    artifactDigest: installation.artifactDigest,
    status: installation.status,
    revision: installation.revision,
    previousReadyRevision: installation.previousReadyRevision,
    previousReadyArtifactDigest: installation.previousReadyArtifactDigest,
    active: false,
    releaseLockDigest: readReleaseLockDigest(installation.resolvedLockJson),
    preparedDigest: installation.preparedDigest,
    health: installation.health,
    createdAt: installation.createdAt,
    components: readSkillInstallationComponentsSync(installation.id).map((component) => ({
      kind: component.kind,
      key: component.key,
      status: component.status,
      errorCode: component.errorCode,
      errorMessage: component.errorMessage,
    })),
    operations: listSkillInstallationOperationsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      installationId: installation.id,
      limit: 10,
    }).map((operation) => ({
      id: operation.id,
      operation: operation.operation,
      status: operation.status,
      claimGeneration: operation.claimGeneration,
      errorMessage: operation.errorMessage,
      evidence: readOperationEvidence(operation.safeResultJson),
    })),
  };
}

export async function uninstallSkillInstallationAction(input: {
  installationId: string;
}): Promise<ActionToastResult<{ removedBindings: number }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.installationId, "installation id");
  const installationId = input.installationId.trim();
  const result = uninstallSkillInstallationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    installationId,
  });
  if (!result.ok) throw new Error(result.reason);

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill installation uninstalled",
    note: `Installation "${installationId}" was uninstalled by ${workspaceContext.currentUser.displayName}.`,
    code: "skill_installation.uninstalled",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: installationId,
      removedBindings: result.removedBindings,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    { removedBindings: result.removedBindings },
    successToast("Runtime 安装已卸载。", "Runtime installation uninstalled."),
  );
}

function readReleaseLockDigest(resolvedLockJson: string): string | undefined {
  try {
    const parsed = JSON.parse(resolvedLockJson) as { lockDigest?: unknown };
    return typeof parsed.lockDigest === "string" ? parsed.lockDigest : undefined;
  } catch {
    return undefined;
  }
}

function readOperationEvidence(safeResultJson: string): SkillInstallationRowView["operations"][number]["evidence"] {
  if (!safeResultJson) return undefined;
  try {
    const parsed = JSON.parse(safeResultJson) as Record<string, unknown>;
    const evidence = {
      ...(typeof parsed.computedDigest === "string" ? { computedDigest: parsed.computedDigest } : {}),
      ...(typeof parsed.cacheHit === "boolean" ? { cacheHit: parsed.cacheHit } : {}),
      ...(Array.isArray(parsed.installedDependencies)
        ? { installedDependencyCount: parsed.installedDependencies.length }
        : {}),
    };
    return Object.keys(evidence).length > 0 ? evidence : undefined;
  } catch {
    return undefined;
  }
}

function parseInspectionManifest(manifestJson: string): {
  dependencies?: Array<{ kind: string; name: string; version: string; integrity?: string }>;
  capabilities?: Array<{ kind: string; catalogSlug: string; requiredTools?: string[] }>;
  services?: Array<{ catalogSlug: string; templateVersion: string; required: boolean }>;
  entrypoints?: Array<{ id: string; path: string; runtime: string }>;
} {
  try {
    return JSON.parse(manifestJson) as ReturnType<typeof parseInspectionManifest>;
  } catch {
    throw new Error("Skill artifact manifest 无法解析。");
  }
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}

function revalidateWorkspaceRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/skills"]);
}
