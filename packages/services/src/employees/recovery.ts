import {
  advanceRecoveryPhaseSync,
  completeRecoveryActivationSync,
  createRecoveryOperationSync,
  createWorkspaceMountOperationSync,
  failRecoveryOperationSync,
  getDatabase,
  readAgentSkillRequirementConfigSync,
  readAgentRuntimeSync,
  readAssignmentArtifactDigestSync,
  readEmployeeBindingGenerationSync,
  readEmployeePersistentWorkspaceSync,
  readEmployeeRuntimeBindingSync,
  readHeadRevisionSync,
  readRecoveryOperationSync,
  readWorkspaceMountOperationSync,
  setEmployeeBindingStatusSync,
  updateRecoveryContextSync,
  readSkillArtifactByDigestSync,
  type EmployeeRecoveryOperationRecord,
  type RecoveryPhase,
} from "@dofe-agent/db";
import type { DaemonProvider } from "@dofe-agent/domain";
import { createAttachmentStorageClient } from "../attachments/storage.ts";
import { listEmployeeSkillIdsSync } from "./employees.ts";
import { verifySkillArtifactIntegritySync } from "../skills/skill-artifacts.ts";
import { createSkillInstallationPlanSync, assertSkillInstallationReadyForTaskSync } from "../skills/installations.ts";
import { readWorkspaceSkillSync } from "../skills/skills.ts";
import { readSkillRequirementDeclarations } from "../skills/requirements.ts";
import { ensureManagedRuntimeCapacitySync, getRuntimeProvisioningTaskDetailSync } from "../runtime-provisioning/runtime-provisioning.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export const RECOVERY_PHASE_ORDER: readonly RecoveryPhase[] = [
  "allocate",
  "mount_workspace",
  "install_skills",
  "resolve_secrets",
  "health_check",
  "activate",
  "completed",
];

export interface RecoveryStepResult {
  operation: EmployeeRecoveryOperationRecord;
  phase: RecoveryPhase;
  ok: boolean;
  error?: string;
}

export interface RunRecoveryInput {
  workspaceId?: string;
  employeeName: string;
  requestedByUserId?: string;
  actorUserId?: string;
  /** When true the operation is created with approval_state=pending and the worker skips it until approved. */
  requireApproval?: boolean;
  /** Target runtime for the new generation. Provided by the caller (control plane) or the allocate step. */
  targetRuntimeId?: string;
  /** Optional verification overrides; when absent real checks run (workspace readable, skills verified, secrets resolvable). */
  verify?: {
    workspaceReadable?: boolean;
    skillsVerified?: boolean;
    secretsResolvable?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Recovery orchestration (EAD-005: declarative expected state)        */
/* ------------------------------------------------------------------ */

/**
 * Creates a recovery operation and marks the binding `recovering`. Every step
 * is recorded with audit context; a failure leaves the operation with its
 * error and a safe restart point. An unverified runtime is never switched in
 * as the current binding.
 */
export function createEmployeeRecoveryOperationSync(input: {
  workspaceId?: string;
  employeeName: string;
  requestedByUserId?: string;
  actorUserId?: string;
  requireApproval?: boolean;
  fromGeneration?: number;
  targetRuntimeId?: string;
}): EmployeeRecoveryOperationRecord {
  const workspaceId = input.workspaceId ?? "default";
  const currentGeneration = readEmployeeBindingGenerationSync(input.employeeName, workspaceId);
  const toGeneration = (currentGeneration ?? 0) + 1;

  const operation = createRecoveryOperationSync({
    workspaceId,
    employeeName: input.employeeName,
    fromGeneration: input.fromGeneration ?? currentGeneration,
    toGeneration,
    requestedByUserId: input.requestedByUserId,
    actorUserId: input.actorUserId,
    approvalState: input.requireApproval ? "pending" : "not_required",
    contextJson: JSON.stringify({
      startedAt: new Date().toISOString(),
      ...(input.targetRuntimeId?.trim() ? { runtimeId: input.targetRuntimeId.trim() } : {}),
    }),
  });

  setEmployeeBindingStatusSync(input.employeeName, "recovering", workspaceId);
  return operation;
}

/**
 * Advances the recovery operation through one phase. Idempotent for
 * already-completed operations; a failed operation returns immediately.
 */
export function runRecoveryStepSync(input: {
  operationId: string;
  workspaceId?: string;
  targetRuntimeId?: string;
  verify?: RunRecoveryInput["verify"];
}): RecoveryStepResult {
  const workspaceId = input.workspaceId ?? "default";
  const operation = readRecoveryOperationSync(input.operationId, workspaceId);
  if (!operation) {
    throw new Error(`Recovery operation "${input.operationId}" does not exist.`);
  }
  if (operation.phase === "completed") {
    return { operation, phase: "completed", ok: true };
  }
  if (operation.phase === "failed") {
    return { operation, phase: "failed", ok: false, error: operation.errorMessage ?? "Recovery failed earlier." };
  }

  try {
    const next = runPhase(operation, { workspaceId, targetRuntimeId: input.targetRuntimeId, verify: input.verify });
    return { operation: next, phase: next.phase, ok: next.phase !== "failed" };
  } catch (error) {
    // Record the failing phase in context; the terminal phase becomes `failed`.
    const failed = failRecoveryOperationSync({
      operationId: operation.id,
      workspaceId,
      errorCode: "recovery_step_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      phase: "failed",
      contextJson: mergeContextJson(operation.contextJson, {
        failedAt: new Date().toISOString(),
        failedPhase: operation.phase,
      }),
    });
    return { operation: failed, phase: "failed", ok: false, error: failed.errorMessage };
  }
}

/**
 * Runs the full recovery orchestration end-to-end: allocate → mount_workspace →
 * install_skills → resolve_secrets → health_check → activate. Returns the
 * terminal operation. Safe to call from tests and the API route.
 */
export function runFullRecoverySync(input: RunRecoveryInput): EmployeeRecoveryOperationRecord {
  const workspaceId = input.workspaceId ?? "default";
  const operation = createEmployeeRecoveryOperationSync({
    workspaceId,
    employeeName: input.employeeName,
    requestedByUserId: input.requestedByUserId,
    actorUserId: input.actorUserId,
    requireApproval: input.requireApproval,
    targetRuntimeId: input.targetRuntimeId,
  });

  for (const phase of RECOVERY_PHASE_ORDER) {
    if (phase === "completed") {
      break;
    }
    const result = runRecoveryStepSync({
      operationId: operation.id,
      workspaceId,
      targetRuntimeId: input.targetRuntimeId,
      verify: input.verify,
    });
    if (!result.ok) {
      // Set the binding back to needs_attention (not online) until an operator acts.
      setEmployeeBindingStatusSync(input.employeeName, "needs_attention", workspaceId);
      return result.operation;
    }
    if (result.phase === "completed") {
      break;
    }
  }

  const finalOperation = readRecoveryOperationSync(operation.id, workspaceId)!;
  if (finalOperation.phase === "completed") {
    setEmployeeBindingStatusSync(input.employeeName, "online", workspaceId);
  }
  return finalOperation;
}

/* ------------------------------------------------------------------ */
/* Per-phase logic                                                     */
/* ------------------------------------------------------------------ */

function runPhase(
  operation: EmployeeRecoveryOperationRecord,
  options: { workspaceId: string; targetRuntimeId?: string; verify?: RunRecoveryInput["verify"] },
): EmployeeRecoveryOperationRecord {
  const { workspaceId, targetRuntimeId } = options;
  const employeeName = operation.employeeName;

  // Re-check the binding lease before every mutating phase. If a concurrent
  // rebind changed the generation, this recovery is stale and must abort.
  if (typeof operation.fromGeneration === "number") {
    assertBindingGenerationCurrentSync({
      workspaceId,
      employeeName,
      expectedGeneration: operation.fromGeneration,
    });
  }

  switch (operation.phase) {
    case "allocate": {
      // PROVISIONAL allocation: resolve/validate the target runtime and record
      // it in the operation context WITHOUT touching the live binding. The
      // current runtime_id/generation stays intact until `activate` passes all
      // recovery checks (EAD-005).
      const ctx = parseRecoveryContextRecord(operation.contextJson);
      // An explicit target (caller-supplied or already recorded in context) is
      // used unconditionally — recovery may target a runtime coming back online.
      const explicitTarget = typeof ctx.runtimeId === "string"
        ? ctx.runtimeId
        : targetRuntimeId?.trim();
      if (explicitTarget) {
        return advanceRecoveryPhaseSync({
          operationId: operation.id,
          phase: "mount_workspace",
          workspaceId,
          contextJson: JSON.stringify({ runtimeId: explicitTarget }),
        });
      }
      // Reuse the current binding's runtime when it is still online.
      const existing = readExistingRuntimeId(employeeName, workspaceId);
      if (existing && runtimeIsOnline(existing, workspaceId)) {
        return advanceRecoveryPhaseSync({
          operationId: operation.id,
          phase: "mount_workspace",
          workspaceId,
          contextJson: JSON.stringify({ runtimeId: existing }),
        });
      }
      // No online runtime: request managed capacity once (remote/managed only),
      // then wait for the provisioning pipeline to reach `succeeded`.
      if (resolveAgentRuntimeMode() === "remote") {
        const actorUserId = operation.actorUserId;
        if (!actorUserId) {
          throw new Error("Recovery runtime provisioning requires an actor user.");
        }
        if (typeof ctx.provisioningTaskId !== "string") {
          const capacity = ensureManagedRuntimeCapacitySync({
            workspaceId,
            actorUserId,
            provider: resolveDesiredProvider(employeeName, workspaceId),
            idempotencyKey: `recovery-${operation.id}`,
          });
          if (capacity.kind === "reused") {
            return advanceRecoveryPhaseSync({
              operationId: operation.id,
              phase: "mount_workspace",
              workspaceId,
              contextJson: JSON.stringify({ runtimeId: capacity.runtimeId }),
            });
          }
          return updateRecoveryContext(operation, { provisioningTaskId: capacity.task.id, waitingFor: "provisioning" });
        }
        const detail = getRuntimeProvisioningTaskDetailSync({
          workspaceId,
          taskId: ctx.provisioningTaskId,
          actorUserId,
        });
        if (detail.task.status === "succeeded" && detail.runtime?.id) {
          return advanceRecoveryPhaseSync({
            operationId: operation.id,
            phase: "mount_workspace",
            workspaceId,
            contextJson: JSON.stringify({ runtimeId: detail.runtime.id }),
          });
        }
        if (detail.task.status === "failed") {
          throw new Error(`Runtime provisioning failed: ${detail.task.lastErrorMessage ?? "unknown error"}.`);
        }
        return operation; // still waiting on the provisioning pipeline
      }
      throw new Error("No online target runtime available for allocation.");
    }
    case "mount_workspace": {
      const ctx = parseRecoveryContextRecord(operation.contextJson);
      const runtimeId = typeof ctx.runtimeId === "string" ? ctx.runtimeId : targetRuntimeId?.trim();
      if (!runtimeId) {
        throw new Error("Recovery has no target runtime to mount.");
      }
      const workspace = readEmployeePersistentWorkspaceSync(employeeName, workspaceId);
      if (!workspace) {
        throw new Error("Employee has no persistent workspace to mount.");
      }
      const head = readHeadRevisionSync(employeeName, workspaceId);
      if (!head) {
        throw new Error("Employee workspace has no committed head revision.");
      }
      if (head.status !== "committed") {
        throw new Error(
          `Workspace head revision is "${head.status}"; only a committed revision may be used for recovery.`,
        );
      }
      // Real mount check: every blob referenced by the head revision's manifest
      // must be present and readable in object storage.
      const blobDigests = parseRevisionManifestBlobDigests(head.manifestJson);
      const storage = createAttachmentStorageClient();
      const unreadable = blobDigests.filter(
        (sha) => !storage.contentAddressedBlobExistsSync({ workspaceId, sha256: sha }),
      );
      if (unreadable.length > 0) {
        throw new Error(
          `Workspace mount failed: ${unreadable.length}/${blobDigests.length} manifest blob(s) unreadable (${unreadable.slice(0, 3).join(", ")}…).`,
        );
      }
      // Every remote target is backed by a registered daemon, regardless of
      // whether capacity was provisioned by AgentSpace. Require that daemon to
      // materialize the revision and report evidence before recovery advances.
      if (resolveAgentRuntimeMode() === "remote") {
        if (typeof ctx.mountOperationId !== "string") {
          const mountOp = createWorkspaceMountOperationSync({
            workspaceId,
            runtimeId,
            employeeName,
            headRevisionId: head.id,
          });
          return updateRecoveryContext(operation, { mountOperationId: mountOp.id, waitingFor: "mount" });
        }
        const mount = readWorkspaceMountOperationSync(ctx.mountOperationId, workspaceId);
        if (mount?.status === "completed") {
          if (mount.headRevisionId !== head.id) {
            throw new Error(
              `Workspace head changed during recovery: mounted ${mount.headRevisionId ?? "none"}, current ${head.id}.`,
            );
          }
          // FS smoke evidence: the daemon must have materialized EXACTLY the
          // head manifest's file count into the persistent runtime workspace.
          // A count mismatch means the mount worker reported success on a
          // partial tree — treat it as a failed mount, never proceed.
          if (
            typeof mount.materializedFiles !== "number" ||
            mount.materializedFiles !== blobDigests.length ||
            typeof mount.mountedPath !== "string" ||
            mount.mountedPath.length === 0
          ) {
            throw new Error(
              `Workspace mount evidence mismatch: daemon materialized ${mount.materializedFiles ?? "unknown"}/${blobDigests.length} files and reported path ${mount.mountedPath ?? "none"}.`,
            );
          }
          return advanceRecoveryPhaseSync({
            operationId: operation.id,
            phase: "install_skills",
            workspaceId,
            contextJson: mergeContextJson(operation.contextJson, {
              headRevisionId: head.id,
              manifestDigest: head.manifestDigest,
              blobCount: blobDigests.length,
              mountMaterializedFiles: mount.materializedFiles,
              mountPath: mount.mountedPath,
            }),
          });
        }
        if (mount?.status === "failed") {
          throw new Error(`Workspace mount failed: ${mount.errorMessage ?? "unknown error"}.`);
        }
        return operation; // waiting for the daemon mount worker
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "install_skills",
        workspaceId,
        contextJson: mergeContextJson(operation.contextJson, { headRevisionId: head.id, manifestDigest: head.manifestDigest, blobCount: blobDigests.length }),
      });
    }
    case "install_skills": {
      const ctx = parseRecoveryContextRecord(operation.contextJson);
      const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
      const verified: Array<{ skillId: string; digest: string; ok: boolean }> = [];
      for (const skillId of skillIds) {
        const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
        if (!digest) {
          throw new Error(`Bound skill "${skillId}" has no pinned digest; recovery is fail-closed.`);
        }
        const artifact = readSkillArtifactByDigestSync(digest, workspaceId);
        if (!artifact) {
          throw new Error(`Bound skill artifact "${digest.slice(0, 12)}..." is missing for skill "${skillId}".`);
        }
        const integrity = verifySkillArtifactIntegritySync(artifact);
        verified.push({ skillId, digest, ok: integrity.ok });
        if (!integrity.ok) {
          throw new Error(
            `Skill "${skillId}" artifact integrity failed: missing=${integrity.missing.length}, mismatched=${integrity.mismatched.length}.`,
          );
        }
      }
      // Every remote target must install the pinned artifacts before activation;
      // managed status only controls allocation, not daemon data-plane safety.
      const installRuntimeId = typeof ctx.runtimeId === "string" ? ctx.runtimeId : targetRuntimeId?.trim();
      const usesRemoteInstall = typeof installRuntimeId === "string"
        && resolveAgentRuntimeMode() === "remote";
      if (usesRemoteInstall) {
        const runtimeId = installRuntimeId;
        if (ctx.plansCreated !== true) {
          for (const skillId of skillIds) {
            const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
            if (!digest) {
              continue;
            }
            const gate = assertSkillInstallationReadyForTaskSync({ workspaceId, runtimeId, artifactDigest: digest });
            if (!gate.ok) {
              createSkillInstallationPlanSync({
                workspaceId,
                runtimeId,
                artifactDigest: digest,
                requestedByUserId: operation.actorUserId,
              });
            }
          }
          return updateRecoveryContext(operation, { plansCreated: true, waitingFor: "skill_install" });
        }
        const allReady = skillIds.every((skillId) => {
          const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
          if (!digest) {
            return true;
          }
          return assertSkillInstallationReadyForTaskSync({ workspaceId, runtimeId, artifactDigest: digest }).ok;
        });
        if (allReady) {
          return advanceRecoveryPhaseSync({
            operationId: operation.id,
            phase: "resolve_secrets",
            workspaceId,
            contextJson: mergeContextJson(operation.contextJson, { skillsVerified: verified }),
          });
        }
        return operation; // waiting for daemon skill-install workers
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "resolve_secrets",
        workspaceId,
        contextJson: mergeContextJson(operation.contextJson, { skillsVerified: verified }),
      });
    }
    case "resolve_secrets": {
      // Secrets live in the encrypted secret store; "resolution" verifies each
      // bound skill that DECLARES requirements has a requirement-config row
      // (the encrypted secret reference) present. Plaintext is never read here.
      const resolved = resolveSecretsResolvable(employeeName, workspaceId, options.verify);
      if (!resolved.ok) {
        throw new Error(`Secrets unresolvable for: ${resolved.missing.join(", ")}.`);
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "health_check",
        workspaceId,
        contextJson: mergeContextJson(operation.contextJson, { secretsResolvable: true, skillCount: resolved.checked }),
      });
    }
    case "health_check": {
      // Every remote runtime must be online with a fresh heartbeat before
      // activation, including externally provisioned daemon runtimes.
      const ctx = parseRecoveryContextRecord(operation.contextJson);
      const healthRuntimeId = typeof ctx.runtimeId === "string" ? ctx.runtimeId : targetRuntimeId?.trim();
      const usesRemoteHealth = typeof healthRuntimeId === "string"
        && resolveAgentRuntimeMode() === "remote";
      if (usesRemoteHealth) {
        const runtimeId = healthRuntimeId;
        const rt = readAgentRuntimeSync(runtimeId);
        if (!rt || rt.workspaceId !== workspaceId || rt.status !== "online") {
          throw new Error("Target runtime is not online; refusing to activate.");
        }
        if (rt.lastHeartbeatAt) {
          const ageMs = Date.now() - Date.parse(rt.lastHeartbeatAt);
          if (!Number.isFinite(ageMs) || ageMs > 90_000) {
            throw new Error("Target runtime heartbeat is stale; refusing to activate.");
          }
        }
        return advanceRecoveryPhaseSync({
          operationId: operation.id,
          phase: "activate",
          workspaceId,
          contextJson: mergeContextJson(operation.contextJson, { healthCheck: "passed", healthCheckedAt: new Date().toISOString() }),
        });
      }
      const healthy = runHealthChecks(employeeName, workspaceId, options.verify);
      if (!healthy) {
        throw new Error("Recovery health pre-check failed; unverified runtime not activated.");
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "activate",
        workspaceId,
        contextJson: mergeContextJson(operation.contextJson, { healthCheck: "passed" }),
      });
    }
    case "activate": {
      // The ONLY step that promotes the provisional recovery to the live
      // binding: atomically switch runtime_id + generation + status=online
      // (guarded against a concurrent rebind). The old runtime keeps a stale
      // generation and loses write rights.
      const context = parseRecoveryContextRecord(operation.contextJson);
      const runtimeId = targetRuntimeId?.trim() || (typeof context.runtimeId === "string" ? context.runtimeId : undefined);
      if (!runtimeId) {
        throw new Error("Recovery has no target runtime to activate.");
      }
      const expectedHeadRevisionId = typeof context.headRevisionId === "string"
        ? context.headRevisionId
        : undefined;
      if (!expectedHeadRevisionId) {
        throw new Error("Recovery activation has no mounted head revision evidence.");
      }
      return completeRecoveryActivationSync({
        operationId: operation.id,
        workspaceId,
        runtimeId,
        expectedHeadRevisionId,
        contextJson: mergeContextJson(operation.contextJson, {
          activatedAt: new Date().toISOString(),
          generation: operation.toGeneration,
          runtimeId,
        }),
      });
    }
    default:
      return operation;
  }
}

function readExistingRuntimeId(employeeName: string, workspaceId: string): string | undefined {
  // The allocate step may reuse the current binding's runtime if it still exists.
  return readEmployeeRuntimeBindingSync(employeeName, workspaceId)?.runtimeId;
}

/** Merges a patch into the operation's context JSON without advancing the phase. */
function updateRecoveryContext(
  operation: EmployeeRecoveryOperationRecord,
  patch: Record<string, unknown>,
): EmployeeRecoveryOperationRecord {
  return updateRecoveryContextSync({
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    contextJson: mergeContextJson(operation.contextJson, patch),
  });
}

/**
 * Merges phase evidence into the existing context instead of replacing it, so
 * the recorded target `runtimeId` survives across phase transitions and the
 * activate step always knows which runtime to promote.
 */
function mergeContextJson(existing: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ ...parseRecoveryContextRecord(existing), ...extra });
}

function parseRecoveryContextRecord(contextJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contextJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Lightweight existence + online check that does not go through the strict runtime mapper. */
function runtimeIsOnline(runtimeId: string, workspaceId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT status FROM agent_runtime WHERE id = ? AND workspace_id = ?`,
  ).get(runtimeId, workspaceId) as { status?: string } | undefined;
  return row?.status === "online";
}

/** Provider of the current binding's runtime, used to request managed capacity. */
function resolveDesiredProvider(employeeName: string, workspaceId: string): DaemonProvider {
  const binding = readEmployeeRuntimeBindingSync(employeeName, workspaceId);
  if (binding?.runtimeId) {
    const runtime = readAgentRuntimeSync(binding.runtimeId);
    if (runtime?.provider) {
      return runtime.provider;
    }
  }
  return "codex";
}

function resolveSecretsResolvable(
  employeeName: string,
  workspaceId: string,
  verify?: RunRecoveryInput["verify"],
): { ok: boolean; missing: string[]; checked: number } {
  if (verify?.secretsResolvable !== undefined) {
    return { ok: verify.secretsResolvable, missing: verify.secretsResolvable ? [] : ["(verify override)"], checked: 0 };
  }
  // A bound skill only needs its encrypted requirement-config row when it
  // actually DECLARES Secret/Config requirements. Skills without a requirement
  // declaration (or with no pinned digest) need no config and must not be
  // misjudged as unrecoverable.
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  const missing: string[] = [];
  let checked = 0;
  for (const skillId of skillIds) {
    const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
    if (!digest) {
      continue; // legacy assignment without a pinned digest — no secret contract
    }
    const skill = readWorkspaceSkillSync(skillId, workspaceId);
    const declaresRequirements = skill
      ? readSkillRequirementDeclarations(skill.configJson).length > 0
      : false;
    if (!declaresRequirements) {
      continue; // no Secret/Config declaration — no config row required
    }
    const config = readAgentSkillRequirementConfigSync({ workspaceId, employeeName, skillId });
    checked += 1;
    if (!config) {
      missing.push(skillId);
    }
  }
  return { ok: missing.length === 0, missing, checked };
}

function parseRevisionManifestBlobDigests(manifestJson: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new Error("Workspace head manifest JSON is invalid; cannot verify mountable blobs.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Workspace head manifest must be an object; cannot verify mountable blobs.");
  }
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new Error("Workspace head manifest is missing a files array; cannot verify mountable blobs.");
  }
  return files.map((file, index) => {
    const sha = file && typeof file === "object" && !Array.isArray(file)
      ? (file as { sha256?: unknown }).sha256
      : undefined;
    if (typeof sha !== "string" || !/^[a-f0-9]{64}$/i.test(sha)) {
      throw new Error(`Workspace head manifest file ${index} has an invalid sha256 digest.`);
    }
    return sha.toLowerCase();
  });
}

function runHealthChecks(
  employeeName: string,
  workspaceId: string,
  verify?: RunRecoveryInput["verify"],
): boolean {
  if (verify) {
    if (verify.workspaceReadable !== undefined && !verify.workspaceReadable) {
      return false;
    }
    if (verify.skillsVerified !== undefined && !verify.skillsVerified) {
      return false;
    }
    if (verify.secretsResolvable !== undefined && !verify.secretsResolvable) {
      return false;
    }
  }
  const workspace = readEmployeePersistentWorkspaceSync(employeeName, workspaceId);
  if (!workspace) {
    return false;
  }
  const head = readHeadRevisionSync(employeeName, workspaceId);
  if (!head) {
    return false;
  }
  // Workspace manifest readable + at least one skill artifact resolvable.
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  let digestCount = 0;
  for (const skillId of skillIds) {
    if (readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId })) {
      digestCount += 1;
    }
  }
  return digestCount === skillIds.length;
}

/* ------------------------------------------------------------------ */
/* Split-brain write guard (EAD-005)                                   */
/* ------------------------------------------------------------------ */

/**
 * STRICT split-brain write guard (EAD-005). Throws unless the binding's current
 * generation EXACTLY equals the expected generation. Any deviation — stale (old
 * node replaying writes after a rebind) OR ahead (a write racing a newer
 * bind) — is rejected before the write can touch the workspace.
 */
export function assertBindingGenerationCurrentSync(input: {
  workspaceId?: string;
  employeeName: string;
  expectedGeneration: number;
}): number {
  const workspaceId = input.workspaceId ?? "default";
  const current = readEmployeeBindingGenerationSync(input.employeeName, workspaceId);
  if (typeof current !== "number") {
    throw new Error(`Employee "${input.employeeName}" has no runtime binding.`);
  }
  if (current !== input.expectedGeneration) {
    throw new Error(
      `STALE_BINDING_GENERATION: current generation is ${current}, expected exactly ${input.expectedGeneration}. ` +
        `Only the current binding lease may write.`,
    );
  }
  return current;
}
