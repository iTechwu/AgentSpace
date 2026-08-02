import {
  activateRecoveryBindingSync,
  advanceRecoveryPhaseSync,
  createRecoveryOperationSync,
  failRecoveryOperationSync,
  readAgentSkillRequirementConfigSync,
  readAssignmentArtifactDigestSync,
  readEmployeeBindingGenerationSync,
  readEmployeePersistentWorkspaceSync,
  readEmployeeRuntimeBindingSync,
  readHeadRevisionSync,
  readRecoveryOperationSync,
  setEmployeeBindingStatusSync,
  readSkillArtifactByDigestSync,
  type EmployeeRecoveryOperationRecord,
  type RecoveryPhase,
} from "@dofe-agent/db";
import { createAttachmentStorageClient } from "../attachments/storage.ts";
import { listEmployeeSkillIdsSync } from "./employees.ts";
import { verifySkillArtifactIntegritySync } from "../skills/skill-artifacts.ts";

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
  fromGeneration?: number;
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
    contextJson: JSON.stringify({ startedAt: new Date().toISOString() }),
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
      contextJson: JSON.stringify({ failedAt: new Date().toISOString(), failedPhase: operation.phase }),
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
      // recovery checks (EAD-005). Container creation is delegated to the
      // runtime-provisioning service by the caller; here we require a runtime id.
      const runtimeId = targetRuntimeId?.trim() || readExistingRuntimeId(employeeName, workspaceId);
      if (!runtimeId) {
        throw new Error("No target runtime available for allocation.");
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "mount_workspace",
        workspaceId,
        contextJson: JSON.stringify({ runtimeId }),
      });
    }
    case "mount_workspace": {
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
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "install_skills",
        workspaceId,
        contextJson: JSON.stringify({ headRevisionId: head.id, manifestDigest: head.manifestDigest, blobCount: blobDigests.length }),
      });
    }
    case "install_skills": {
      const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
      const verified: Array<{ skillId: string; digest: string; ok: boolean }> = [];
      for (const skillId of skillIds) {
        const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
        if (!digest) {
          continue; // legacy assignment without a pinned digest is skipped (not fatal)
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
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "resolve_secrets",
        workspaceId,
        contextJson: JSON.stringify({ skillsVerified: verified }),
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
        contextJson: JSON.stringify({ secretsResolvable: true, skillCount: resolved.checked }),
      });
    }
    case "health_check": {
      const healthy = runHealthChecks(employeeName, workspaceId, options.verify);
      if (!healthy) {
        throw new Error("Recovery health pre-check failed; unverified runtime not activated.");
      }
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "activate",
        workspaceId,
        contextJson: JSON.stringify({ healthCheck: "passed" }),
      });
    }
    case "activate": {
      // The ONLY step that promotes the provisional recovery to the live
      // binding: atomically switch runtime_id + generation + status=online
      // (guarded against a concurrent rebind). The old runtime keeps a stale
      // generation and loses write rights.
      const context = parseRecoveryContext(operation.contextJson);
      const runtimeId = targetRuntimeId?.trim() || context.runtimeId;
      if (!runtimeId) {
        throw new Error("Recovery has no target runtime to activate.");
      }
      activateRecoveryBindingSync({
        workspaceId,
        employeeName,
        runtimeId,
        generation: operation.toGeneration,
        expectedPreviousGeneration: operation.fromGeneration,
      });
      return advanceRecoveryPhaseSync({
        operationId: operation.id,
        phase: "completed",
        workspaceId,
        contextJson: JSON.stringify({ activatedAt: new Date().toISOString(), generation: operation.toGeneration, runtimeId }),
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

function resolveSecretsResolvable(
  employeeName: string,
  workspaceId: string,
  verify?: RunRecoveryInput["verify"],
): { ok: boolean; missing: string[]; checked: number } {
  if (verify?.secretsResolvable !== undefined) {
    return { ok: verify.secretsResolvable, missing: verify.secretsResolvable ? [] : ["(verify override)"], checked: 0 };
  }
  // Every bound skill that declares requirements must have its encrypted
  // requirement-config row present (the secret reference). Skills without a
  // requirement declaration need no config.
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  const missing: string[] = [];
  let checked = 0;
  for (const skillId of skillIds) {
    const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
    if (!digest) {
      continue; // legacy assignment without a pinned digest — no secret contract
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
  try {
    const manifest = JSON.parse(manifestJson) as { files?: Array<{ sha256?: string }> };
    return (manifest.files ?? [])
      .map((file) => file.sha256)
      .filter((sha): sha is string => typeof sha === "string" && sha.length > 0);
  } catch {
    return [];
  }
}

function parseRecoveryContext(contextJson: string): { runtimeId?: string } {
  try {
    const parsed = JSON.parse(contextJson) as { runtimeId?: unknown };
    return { runtimeId: typeof parsed.runtimeId === "string" ? parsed.runtimeId : undefined };
  } catch {
    return {};
  }
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
