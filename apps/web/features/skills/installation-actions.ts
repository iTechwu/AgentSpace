"use server";

import {
  listInstallableRuntimesForWorkspaceSync,
  listSkillArtifactsForSkillSync,
  listSkillInstallationOperationsSync,
  listSkillInstallationsSync,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationSync,
} from "@dofe-agent/db";
import {
  approveSkillUpgradeSync,
  buildSkillInstallationComponentsSync,
  computeSkillReleaseLockSync,
  computeSkillUpgradeDiffHashSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  diffSkillArtifactsSync,
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
  };
}

/** Runtimes available for skill installation in the current workspace. */
export async function listSkillInstallableRuntimesAction(): Promise<SkillInstallableRuntime[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return listInstallableRuntimesForWorkspaceSync(workspaceContext.currentWorkspace.id);
}

export async function createSkillInstallationAction(input: {
  skillId: string;
  runtimeId: string;
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
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    { installationId: installation.id, status: installation.status },
    infoToast("安装计划已创建，daemon 将在目标 Runtime 上准备环境。", "Installation plan created; the daemon will prepare on the target runtime."),
  );
}

export async function createSkillUpgradeAction(input: {
  skillId: string;
  runtimeId: string;
  previousInstallationId: string;
  candidateArtifactDigest?: string;
  approved?: boolean;
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
      }
    }
  }
  rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return rows;
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
