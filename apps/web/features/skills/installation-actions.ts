"use server";

import {
  listInstallableRuntimesForWorkspaceSync,
  listSkillArtifactsForSkillSync,
  listSkillInstallationOperationsSync,
  listSkillInstallationsSync,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationSync,
} from "@dofe-agent/db";
import {
  approveSkillUpgradeSync,
  computeSkillUpgradeDiffHashSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  diffSkillArtifactsSync,
  rollbackSkillInstallationSync,
  tryRecordWorkspaceAuditEventSync,
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
  approved?: boolean;
}): Promise<ActionToastResult<{ installationId: string; breaking: boolean; changeCount: number }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.runtimeId, "runtime id");
  assertRequired(input.previousInstallationId, "previous installation id");

  const digest = readActiveArtifactDigestForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!digest) {
    throw new Error("此 Skill 尚无 artifact。");
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
    const previousArtifact = readSkillArtifactByDigestSync(previous.artifactDigest, workspaceContext.currentWorkspace.id);
    const nextArtifact = readSkillArtifactByDigestSync(digest, workspaceContext.currentWorkspace.id);
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
        toDigest: digest,
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
    artifactDigest: digest,
    previousReadyInstallationId: input.previousInstallationId.trim(),
    requestedByUserId: workspaceContext.currentUser.id,
    ...(approvalId ? { approvalId } : {}),
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill upgrade planned",
    note: `Upgrade for skill "${input.skillId}" (${digest.slice(0, 12)}…) planned by ${workspaceContext.currentUser.displayName} (breaking=${breaking}, changes=${changeCount}).`,
    code: "skill_installation.upgrade_planned",
    data: {
      actorType: "session_user",
      resourceType: "skill_installation",
      resourceId: installation.id,
      skillId: input.skillId.trim(),
      runtimeId: input.runtimeId.trim(),
      artifactDigest: digest,
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

export async function rollbackSkillInstallationAction(input: {
  installationId: string;
}): Promise<ActionToastResult<{ previousReadyDigest?: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.installationId, "installation id");

  const installation = readSkillInstallationSync(input.installationId.trim(), workspaceContext.currentWorkspace.id);
  const artifact = installation
    ? readSkillArtifactByDigestSync(installation.artifactDigest, workspaceContext.currentWorkspace.id)
    : null;

  const result = rollbackSkillInstallationSync({
    installationId: input.installationId.trim(),
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: artifact?.skillId,
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
  createdAt: string;
  components: Array<{ kind: string; key: string; status: string }>;
  operations: Array<{ id: string; operation: string; status: string; errorMessage?: string }>;
}

export async function listSkillInstallationRowsForSkillAction(input: {
  skillId: string;
}): Promise<SkillInstallationRowView[]> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");

  const artifacts = listSkillArtifactsForSkillSync(input.skillId.trim(), workspaceContext.currentWorkspace.id);
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
        createdAt: installation.createdAt,
        components: readSkillInstallationComponentsSync(installation.id).map((component) => ({
          kind: component.kind,
          key: component.key,
          status: component.status,
        })),
        operations: listSkillInstallationOperationsSync({
          workspaceId: workspaceContext.currentWorkspace.id,
          installationId: installation.id,
          limit: 10,
        }).map((operation) => ({
          id: operation.id,
          operation: operation.operation,
          status: operation.status,
          errorMessage: operation.errorMessage,
        })),
      });
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
    createdAt: installation.createdAt,
    components: readSkillInstallationComponentsSync(installation.id).map((component) => ({
      kind: component.kind,
      key: component.key,
      status: component.status,
    })),
    operations: listSkillInstallationOperationsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      installationId: installation.id,
      limit: 10,
    }).map((operation) => ({
      id: operation.id,
      operation: operation.operation,
      status: operation.status,
      errorMessage: operation.errorMessage,
    })),
  };
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}

function revalidateWorkspaceRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/skills"]);
}
