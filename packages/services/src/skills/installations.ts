import {
  createSkillInstallationSync,
  completeSkillInstallationOperationSync as completeSkillOperationDbSync,
  failSkillInstallationOperationSync as failSkillOperationDbSync,
  getDatabase,
  readContentBlobSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  readSkillInstallationByLockSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationOperationSync,
  readSkillInstallationSync,
  listSkillInstallationsSync,
  readStoredSkillActiveArtifactDigestSync,
  listStoredAgentSkillAssignmentsSync,
  readTaskSkillExecutionSnapshotSync,
  writeTaskSkillExecutionSnapshotSync,
  setSkillInstallationPreparedDigestSync,
  setSkillInstallationPreparedPathSync,
  setSkillInstallationStatusSync,
  updateSkillInstallationComponentStatusSync,
  withTransaction,
  type ContentBlobRecord,
  type SkillInstallationComponentInput,
  type StoredSkillInstallationOperationRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import type {
  ClaimedSkillInstallationOperation,
  SkillComponentKind,
  SkillComponentStatus,
  SkillInstallationOperationComponentStatus,
  SkillInstallationOperationExpectedComponent,
  SkillInstallationOperationKind,
  TaskSkillExecutionSnapshot,
} from "@dofe-agent/domain";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { createSkillInstallationOperationSync } from "@dofe-agent/db";
import { createAttachmentStorageClient, type AttachmentStorageReadInput } from "../attachments/storage.ts";
import { evaluateSkillInstallationCapabilitiesSync, resolveSkillServiceComponentStatusSync } from "./capabilities.ts";
import { buildSkillOperationRequestSnapshotJson } from "./installations-protocol.ts";
import { computeSkillReleaseLockSync } from "./release.ts";
import { queueManagedSkillServiceForInstallationSync } from "../skill-services/bindings.ts";

/* ------------------------------------------------------------------ */
/* Control plane: installation plans                                   */
/* ------------------------------------------------------------------ */

/**
 * Creates an installation plan for an artifact on a target runtime. The plan
 * is a data model (installation + components + queued operation), NOT an
 * execution; the daemon executes it via the operation claim/complete protocol.
 * `ready` is only reached when every required component verifies on the target
 * runtime (02-架构设计.md §4.1).
 */
/** Builds the required component list for an artifact (deps, scripts, capabilities). */
export function buildSkillInstallationComponentsSync(input: {
  workspaceId?: string;
  artifactDigest: string;
}): SkillInstallationComponentInput[] {
  const artifact = readSkillArtifactByDigestSync(input.artifactDigest, input.workspaceId);
  if (!artifact) {
    throw new Error(`Skill artifact "${input.artifactDigest}" does not exist in this workspace.`);
  }
  let manifest: {
    dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
    entrypoints?: Array<{ path?: string }>;
    capabilities?: Array<{ kind?: string; catalogSlug?: string }>;
    services?: Array<{ catalogSlug?: string; required?: boolean }>;
  };
  try {
    manifest = JSON.parse(artifact.manifestJson) as typeof manifest;
  } catch {
    throw new Error(`Skill artifact "${input.artifactDigest}" has an invalid manifest.`);
  }
  const fileRecords = readSkillArtifactFilesSync(artifact.id);
  return buildInstallationComponents(manifest, fileRecords);
}

export function createSkillInstallationPlanSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
  requestedByUserId?: string;
}): StoredSkillInstallationRecord {
  const artifact = readSkillArtifactByDigestSync(input.artifactDigest, input.workspaceId);
  if (!artifact) {
    throw new Error(`Skill artifact "${input.artifactDigest}" does not exist in this workspace.`);
  }

  const components = buildSkillInstallationComponentsSync({ workspaceId: input.workspaceId, artifactDigest: input.artifactDigest });
  const lock = computeSkillReleaseLockSync(artifact, input.workspaceId ?? "default");
  const resolvedLockJson = JSON.stringify(lock);

  const installation = createSkillInstallationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: artifact.digest,
    // Fail-closed: an artifact whose required services/MCP capabilities cannot be
    // pinned by the catalog is blocked at plan time — it can never reach ready.
    status: lock.unresolvedRequired.length > 0 ? "blocked" : "preparing",
    components,
    resolvedLockJson,
  });

  createSkillInstallationOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    installationId: installation.id,
    operation: "prepare",
    requestedByUserId: input.requestedByUserId,
    requestSnapshotJson: buildSkillOperationRequestSnapshotJson({
      artifactDigest: artifact.digest,
      expectedComponents: components.map((c) => ({ kind: c.kind, key: c.key })),
    }),
  });

  // Queue a managed-service provision operation for every declared service so the
  // managed node can bring it up; the control plane binds it on completion.
  for (const service of readManifestServices(artifact.manifestJson)) {
    if (service.catalogSlug) {
      queueManagedSkillServiceForInstallationSync({
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        installationId: installation.id,
        catalogSlug: service.catalogSlug,
        templateVersion: service.templateVersion ?? "1",
      });
    }
  }

  return installation;
}

function readManifestServices(manifestJson: string): Array<{ catalogSlug?: string; templateVersion?: string }> {
  try {
    const manifest = JSON.parse(manifestJson) as { services?: Array<{ catalogSlug?: string; templateVersion?: string }> };
    return manifest.services ?? [];
  } catch {
    return [];
  }
}

function buildInstallationComponents(
  manifest: {
    dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
    entrypoints?: Array<{ path?: string }>;
    capabilities?: Array<{ kind?: string; catalogSlug?: string }>;
    services?: Array<{ catalogSlug?: string; required?: boolean }>;
  },
  fileRecords: Array<{ path: string; mode: string }>,
): SkillInstallationComponentInput[] {
  // Deduplicated by (kind, key) so an entrypoint that is ALSO a 0755 file yields
  // ONE script component (a duplicate would violate UNIQUE(installation, kind, key)).
  const components = new Map<string, SkillInstallationComponentInput>();

  // Manifest dependencies use `manager` (SkillDependencyDeclaration) or
  // `kind` (DspDependency); accept both for forward compatibility.
  for (const dependency of manifest.dependencies ?? []) {
    components.set("dependency:" + keyOf(dependency), {
      kind: "dependency",
      key: `${dependency.manager ?? dependency.kind}:${dependency.name}@${dependency.version}`,
    });
  }
  for (const entrypoint of manifest.entrypoints ?? []) {
    if (entrypoint.path) {
      components.set(`script:${entrypoint.path}`, { kind: "script", key: entrypoint.path });
    }
  }
  for (const file of fileRecords) {
    if (file.mode === "0755") {
      components.set(`script:${file.path}`, { kind: "script", key: file.path });
    }
  }
  for (const capability of manifest.capabilities ?? []) {
    const kind = capability.kind === "cli" ? "cli" : "mcp";
    components.set(`${kind}:${capability.catalogSlug}`, { kind, key: `${kind}:${capability.catalogSlug}` });
  }
  // Every declared service gets a `service` component so a required service can
  // never be silently skipped — the daemon's service verifier blocks it until the
  // managed-service worker exists, which is the correct fail-closed behavior.
  for (const service of manifest.services ?? []) {
    if (!service.catalogSlug) {
      continue;
    }
    const key = `service:${service.catalogSlug}`;
    components.set(key, { kind: "service", key });
  }

  // Package integrity is always a required component so an artifact with no
  // declared dependencies still goes through verification before `ready`.
  if (components.size === 0) {
    components.set("dependency:package:integrity", { kind: "dependency", key: "package:integrity" });
  }
  return [...components.values()];
}

function keyOf(dependency: { manager?: string; kind?: string; name?: string; version?: string }): string {
  return `${dependency.manager ?? dependency.kind}:${dependency.name}@${dependency.version}`;
}

/* ------------------------------------------------------------------ */
/* Operation protocol (daemon execution)                               */
/* ------------------------------------------------------------------ */

/** Builds the one-time authenticated payload delivered to the daemon on claim. */
export async function resolveClaimedSkillInstallationOperation(input: {
  workspaceId: string;
  operation: StoredSkillInstallationOperationRecord;
}): Promise<ClaimedSkillInstallationOperation | null> {
  const installation = readSkillInstallationSync(input.operation.installationId, input.workspaceId);
  if (!installation) {
    return null;
  }
  const artifact = readSkillArtifactByDigestSync(installation.artifactDigest, input.workspaceId);
  if (!artifact) {
    return null;
  }
  const fileRecords = readSkillArtifactFilesSync(artifact.id);
  const expectedComponents = readSkillInstallationOperationExpectedComponentsSync(input.operation, input.workspaceId);
  const storageClient = createAttachmentStorageClient();

  return {
    operationId: input.operation.id,
    workspaceId: input.operation.workspaceId,
    runtimeId: input.operation.runtimeId,
    installationId: installation.id,
    operation: input.operation.operation as SkillInstallationOperationKind,
    artifactDigest: artifact.digest,
    artifactName: artifact.name,
    manifestJson: artifact.manifestJson,
    ...readReleaseLockDigest(installation.resolvedLockJson),
    files: await Promise.all(
      fileRecords.map(async (file) => {
        const blob = readContentBlobSync(file.sha256, input.workspaceId);
        const readInput: AttachmentStorageReadInput | undefined = blob
          ? {
              storageProvider: blob.storageProvider,
              storageBucket: blob.storageBucket,
              storageRegion: blob.storageRegion,
              storageEndpoint: blob.storageEndpoint,
              storageKey: blob.storageKey,
              storedPath: buildBlobStoredPath(blob),
            }
          : undefined;
        return {
          path: file.path,
          sha256: file.sha256,
          size: file.sizeBytes,
          mediaType: file.mediaType,
          mode: file.mode,
          downloadUrl: readInput ? (await storageClient.createReadUrl(readInput)) ?? undefined : undefined,
          storedPath: readInput?.storedPath,
        };
      }),
    ),
    components: expectedComponents.map((component) => ({
      kind: component.kind,
      key: component.key,
      // The expected set carries no live status; the daemon's verifier reads only
      // kind/key, so synthesize an informational "pending".
      status: "pending",
    })),
    createdAt: input.operation.createdAt,
  };
}

/**
 * Resolves the FROZEN expected component set for an operation, shared by claim
 * and complete so they always agree. Prefers the canonical
 * `request_snapshot_json.expectedComponents`; falls back to the live
 * `skill_installation_component` rows for pre-canonical rows (whose components
 * are still pending at first complete, so the live set is the true expected
 * set). On an unparseable snapshot, the fallback is used rather than failing.
 */
function readSkillInstallationOperationExpectedComponentsSync(
  operation: Pick<StoredSkillInstallationOperationRecord, "requestSnapshotJson" | "installationId">,
  workspaceId?: string,
): SkillInstallationOperationExpectedComponent[] {
  try {
    const snapshot = JSON.parse(operation.requestSnapshotJson) as {
      expectedComponents?: unknown;
    };
    if (Array.isArray(snapshot.expectedComponents)) {
      const expected: SkillInstallationOperationExpectedComponent[] = [];
      for (const entry of snapshot.expectedComponents) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.kind === "string" && typeof record.key === "string") {
          expected.push({ kind: record.kind as SkillComponentKind, key: record.key });
        }
      }
      if (expected.length > 0) {
        return expected;
      }
    }
  } catch {
    // Fall through to the live component set.
  }
  return readSkillInstallationComponentsSync(operation.installationId).map((component) => ({
    kind: component.kind,
    key: component.key,
  }));
}

function readReleaseLockDigest(resolvedLockJson: string): { releaseLockDigest: string } | Record<string, never> {
  try {
    const lock = JSON.parse(resolvedLockJson) as { lockDigest?: unknown };
    if (typeof lock.lockDigest === "string" && lock.lockDigest.length > 0) {
      return { releaseLockDigest: lock.lockDigest };
    }
  } catch {
    // Absent/malformed lock → omit the digest from the claim.
  }
  return {};
}

function buildBlobStoredPath(blob: ContentBlobRecord): string {
  if (blob.storageProvider === "local") {
    return `local:///${blob.storageKey}`;
  }
  if (blob.storageBucket) {
    return `tos://${blob.storageBucket}/${blob.storageKey}`;
  }
  return blob.storageKey;
}

export type SkillInstallationOperationCompletionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "invalid_payload"
        | "component_set_mismatch"
        | "evidence_mismatch"
        | "not_completable"
        | "operation_not_found";
      reason: string;
    };

/** Internal error carrying a stable completion-failure code across a transaction rollback. */
class SkillOperationConflictError extends Error {
  readonly code: "not_completable" | "component_set_mismatch";

  constructor(code: "not_completable" | "component_set_mismatch") {
    super(code);
    this.name = "SkillOperationConflictError";
    this.code = code;
  }
}

/**
 * Completes a skill installation operation. FAIL-CLOSED per P0-5:
 * - `componentStatuses` must be EXACTLY the operation's frozen expected set
 *   (no unknown, duplicate, or missing components; statuses validated by the
 *   shared payload parser at the route boundary).
 * - `safeResultJson` evidence must parse and its `computedDigest` must equal the
 *   claimed artifact digest (malformed/missing/mismatched evidence is rejected —
 *   the deliberate reversal of the old best-effort behavior).
 * - The operation succeed + all component updates + readiness recompute happen
 *   in ONE transaction; any failure rolls everything back (no partial state).
 */
export function completeSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  safeResultJson?: string;
  componentStatuses?: SkillInstallationOperationComponentStatus[];
}): SkillInstallationOperationCompletionResult {
  const workspaceId = input.workspaceId ?? "default";
  const operation = readSkillInstallationOperationSync(input.operationId, workspaceId);
  if (!operation) {
    return { ok: false, code: "operation_not_found", reason: "Skill operation does not exist." };
  }
  if (operation.status !== "claimed" && operation.status !== "running") {
    return { ok: false, code: "not_completable", reason: `Operation is "${operation.status}", not claimed or running.` };
  }

  const expectedComponents = readSkillInstallationOperationExpectedComponentsSync(operation, workspaceId);
  const expectedKeys = new Set(expectedComponents.map((component) => `${component.kind}:${component.key}`));
  const submitted = input.componentStatuses ?? [];
  if (submitted.length !== expectedKeys.size) {
    return {
      ok: false,
      code: "component_set_mismatch",
      reason: `Expected exactly ${expectedKeys.size} component statuses, got ${submitted.length}.`,
    };
  }
  const seen = new Set<string>();
  for (const component of submitted) {
    const key = `${component.kind}:${component.key}`;
    if (!expectedKeys.has(key)) {
      return { ok: false, code: "component_set_mismatch", reason: `Component "${key}" is not in the expected set.` };
    }
    if (seen.has(key)) {
      return { ok: false, code: "component_set_mismatch", reason: `Component "${key}" is reported more than once.` };
    }
    seen.add(key);
  }

  const artifactDigest = readOperationArtifactDigest(operation);
  if (!artifactDigest) {
    return { ok: false, code: "invalid_payload", reason: "Operation snapshot is missing an artifact digest." };
  }
  const evidence = parseCompletionEvidence(input.safeResultJson);
  if (!evidence || evidence.computedDigest !== artifactDigest) {
    return {
      ok: false,
      code: "evidence_mismatch",
      reason: "Completion evidence digest does not match the claimed artifact digest.",
    };
  }

  try {
    withTransaction(getDatabase(), () => {
      const done = completeSkillOperationDbSync({
        operationId: input.operationId,
        workspaceId,
        safeResultJson: input.safeResultJson,
      });
      if (!done) {
        throw new SkillOperationConflictError("not_completable");
      }
      for (const component of submitted) {
        // Service components are control-plane-decided: the daemon reports
        // `pending`, and readiness is overridden from the service binding state
        // (bound + managed service ready → ready; otherwise blocked, fail-closed).
        const resolved = component.kind === "service"
          ? resolveSkillServiceComponentStatusSync(component.key, operation.installationId, workspaceId)
          : { status: component.status };
        const changed = updateSkillInstallationComponentStatusSync({
          installationId: operation.installationId,
          kind: component.kind,
          key: component.key,
          status: resolved.status,
          errorCode: resolved.status === "ready" ? undefined : "skill_installation.service_not_ready",
          errorMessage: resolved.status === "ready" ? undefined : `Service is not ready on this runtime (binding missing or not healthy).`,
          verifiedAt: resolved.status === "ready" ? new Date().toISOString() : undefined,
          lastOperationId: operation.id,
        });
        if (!changed) {
          // Component row vanished between set-match and the transaction: reject
          // the completion rather than leaving a silent 0-row no-op.
          throw new SkillOperationConflictError("component_set_mismatch");
        }
      }
      // Record the daemon-side materialized path (digest-keyed Runtime cache).
      if (evidence.preparedPath) {
        setSkillInstallationPreparedPathSync({ installationId: operation.installationId, workspaceId, preparedPath: evidence.preparedPath });
      }
      if (evidence.computedDigest) {
        setSkillInstallationPreparedDigestSync({ installationId: operation.installationId, workspaceId, preparedDigest: evidence.computedDigest });
      }
      evaluateSkillInstallationReadinessSync(operation.installationId, workspaceId);
    });
  } catch (error) {
    if (error instanceof SkillOperationConflictError) {
      return { ok: false, code: error.code, reason: error.message };
    }
    throw error;
  }
  return { ok: true };
}

/**
 * Fails a skill installation operation. Accepts an optional (subset-of-expected)
 * `componentStatuses` to persist as partial verification evidence, then blocks
 * every remaining unfinished component so the installation can never be mistaken
 * for ready. All updates are atomic with the op fail.
 */
export function failSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode?: string;
  errorMessage: string;
  componentStatuses?: SkillInstallationOperationComponentStatus[];
}): SkillInstallationOperationCompletionResult {
  const workspaceId = input.workspaceId ?? "default";
  const operation = readSkillInstallationOperationSync(input.operationId, workspaceId);
  if (!operation) {
    return { ok: false, code: "operation_not_found", reason: "Skill operation does not exist." };
  }
  if (operation.status !== "claimed" && operation.status !== "running") {
    return { ok: false, code: "not_completable", reason: `Operation is "${operation.status}", not claimed or running.` };
  }

  const expectedComponents = readSkillInstallationOperationExpectedComponentsSync(operation, workspaceId);
  const expectedKeys = new Set(expectedComponents.map((component) => `${component.kind}:${component.key}`));
  const submitted = input.componentStatuses ?? [];
  const seen = new Set<string>();
  for (const component of submitted) {
    const key = `${component.kind}:${component.key}`;
    if (!expectedKeys.has(key)) {
      return { ok: false, code: "component_set_mismatch", reason: `Component "${key}" is not in the expected set.` };
    }
    if (seen.has(key)) {
      return { ok: false, code: "component_set_mismatch", reason: `Component "${key}" is reported more than once.` };
    }
    seen.add(key);
  }

  try {
    withTransaction(getDatabase(), () => {
      const done = failSkillOperationDbSync({
        operationId: input.operationId,
        workspaceId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      if (!done) {
        throw new SkillOperationConflictError("not_completable");
      }
      for (const component of submitted) {
        const changed = updateSkillInstallationComponentStatusSync({
          installationId: operation.installationId,
          kind: component.kind,
          key: component.key,
          status: component.status,
          errorCode: component.errorCode,
          errorMessage: component.errorMessage,
          verifiedAt: component.status === "ready" ? new Date().toISOString() : undefined,
          lastOperationId: operation.id,
        });
        if (!changed) {
          throw new SkillOperationConflictError("component_set_mismatch");
        }
      }
      // A failed prepare blocks every unfinished required component so the
      // installation can never be mistaken for ready.
      const components = readSkillInstallationComponentsSync(operation.installationId);
      for (const component of components) {
        if (component.status === "pending" || component.status === "preparing") {
          updateSkillInstallationComponentStatusSync({
            installationId: operation.installationId,
            kind: component.kind,
            key: component.key,
            status: "blocked",
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            lastOperationId: operation.id,
          });
        }
      }
      evaluateSkillInstallationReadinessSync(operation.installationId, workspaceId);
    });
  } catch (error) {
    if (error instanceof SkillOperationConflictError) {
      return { ok: false, code: error.code, reason: error.message };
    }
    throw error;
  }
  return { ok: true };
}

/**
 * Control-plane service readiness (02-架构设计.md §4.3): a `service:<slug>`
 * component is `ready` only when a skill_service_binding exists whose managed
 * service is `ready` on the runtime; otherwise `blocked` (fail-closed — a
 * declared service must never be silently skipped).
 */
function parseCompletionEvidence(
  safeResultJson: string | undefined,
): { computedDigest?: string; preparedPath?: string } | null {
  if (!safeResultJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(safeResultJson) as Record<string, unknown>;
    return {
      ...(typeof parsed.computedDigest === "string" && parsed.computedDigest.length > 0
        ? { computedDigest: parsed.computedDigest }
        : {}),
      ...(typeof parsed.preparedPath === "string" && parsed.preparedPath.length > 0 ? { preparedPath: parsed.preparedPath } : {}),
    };
  } catch {
    return null;
  }
}

function readOperationArtifactDigest(
  operation: Pick<StoredSkillInstallationOperationRecord, "requestSnapshotJson">,
): string | undefined {
  try {
    const snapshot = JSON.parse(operation.requestSnapshotJson) as { artifactDigest?: unknown };
    return typeof snapshot.artifactDigest === "string" && snapshot.artifactDigest.length > 0
      ? snapshot.artifactDigest
      : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Readiness gate                                                      */
/* ------------------------------------------------------------------ */

/**
 * Recomputes the installation status from its component states. `ready` means
 * EVERY component verified; a single `blocked`/`failed` makes the installation
 * `blocked`; a `degraded` component makes it `degraded`. Nothing is "best
 * effort" (01-产品方案.md §4).
 *
 * mcp/cli capability components are re-resolved against ready platform
 * capabilities on every evaluation, so `ready` can never be reached while a
 * declared capability is unresolved (02-架构设计.md §5).
 */
export function evaluateSkillInstallationReadinessSync(
  installationId: string,
  workspaceId?: string,
): "preparing" | "blocked" | "ready" | "degraded" {
  const installation = readSkillInstallationSync(installationId, workspaceId);
  if (installation) {
    evaluateSkillInstallationCapabilitiesSync({
      installationId,
      workspaceId: installation.workspaceId,
      runtimeId: installation.runtimeId,
      artifactDigest: installation.artifactDigest,
    });
  }
  const components = readSkillInstallationComponentsSync(installationId);
  if (components.length === 0) {
    setSkillInstallationStatusSync({ installationId, workspaceId, status: "blocked", health: "unverified" });
    return "blocked";
  }
  if (components.every((component) => component.status === "ready")) {
    setSkillInstallationStatusSync({ installationId, workspaceId, status: "ready", health: "healthy", verifiedAt: new Date().toISOString() });
    return "ready";
  }
  if (components.some((component) => component.status === "blocked" || component.status === "failed")) {
    setSkillInstallationStatusSync({ installationId, workspaceId, status: "blocked", health: "failed" });
    return "blocked";
  }
  if (components.some((component) => component.status === "degraded")) {
    setSkillInstallationStatusSync({ installationId, workspaceId, status: "degraded", health: "degraded" });
    return "degraded";
  }
  setSkillInstallationStatusSync({ installationId, workspaceId, status: "preparing", health: "unknown" });
  return "preparing";
}

/**
 * Task-time freshness gate: only a `ready` installation may enter a task.
 *
 * Resolves the installation by `(workspace, runtime, artifactDigest)` WITHOUT a
 * hardcoded revision — an upgraded skill creates v2/v3 installations, so the
 * gate must pick the highest revision (matching `nextRevision` v1→v2→v3 in
 * release.ts) rather than always looking up `v1`. Among the installations for
 * the 3-tuple the highest revision is selected; its real status is returned so
 * the blocker message stays truthful (a degraded installation reports
 * `degraded`, not a misleading "no installation").
 */
export function assertSkillInstallationReadyForTaskSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
}): { ok: true; installationId: string; revision: string } | { ok: false; status: string; reason: string } {
  const installation = readHighestRevisionSkillInstallationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
  });
  if (!installation) {
    return {
      ok: false,
      status: "blocked",
      reason: `Skill artifact "${input.artifactDigest}" has no installation on this runtime.`,
    };
  }
  if (installation.status !== "ready") {
    return {
      ok: false,
      status: installation.status,
      reason: `Installation is "${installation.status}" (not ready); new tasks will not load this skill.`,
    };
  }
  return { ok: true, installationId: installation.id, revision: installation.revision };
}

/**
 * Returns the highest-revision installation for a `(workspace, runtime, artifactDigest)`
 * triple, regardless of status. Revision labels follow `^v(\d+)$` (release.ts
 * `nextRevision`); non-conforming labels sort below conforming ones. Returns null
 * when no installation exists for the triple.
 */
export function readHighestRevisionSkillInstallationSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
}): StoredSkillInstallationRecord | null {
  const installations = listSkillInstallationsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
  });
  if (installations.length === 0) {
    return null;
  }
  return installations.reduce((best, current) =>
    compareRevision(current.revision) > compareRevision(best.revision) ? current : best,
  );
}

function compareRevision(revision: string): number {
  const match = revision.match(/^v(\d+)$/);
  if (!match) {
    return -1;
  }
  return Number.parseInt(match[1]!, 10);
}

/**
 * Resolves the immutable Skill execution snapshot for a task: for every
 * assigned (non-builtin) skill, the digest is the assignment pin
 * (`agent_skill.skill_artifact_digest`) falling back to the skill's active
 * digest, then the highest-revision `ready` installation on the runtime is
 * pinned. Skills without a ready installation are omitted — the task-time
 * readiness gate surfaces their blocker. The snapshot is what a running task
 * materializes against, so a mid-flight upgrade/rollback cannot drift it.
 */
export function resolveTaskSkillExecutionSnapshotSync(input: {
  workspaceId?: string;
  runtimeId: string;
  agentName: string | undefined;
  agentSkills: WorkspaceSkill[];
}): TaskSkillExecutionSnapshot {
  const workspaceId = input.workspaceId ?? "default";
  const now = new Date().toISOString();
  const entries: TaskSkillExecutionSnapshot["entries"] = [];

  const assignments = input.agentName
    ? listStoredAgentSkillAssignmentsSync(workspaceId).filter(
        (assignment) => assignment.employeeName === input.agentName,
      )
    : [];
  const digestBySkillId = new Map<string, string | undefined>(
    assignments.map((assignment) => [assignment.skillId, assignment.skillArtifactDigest]),
  );
  const rolloutPinBySkillId = new Map<string, string | undefined>(
    assignments.map((assignment) => [assignment.skillId, assignment.rolloutPin]),
  );

  for (const skill of input.agentSkills) {
    if (skill.sourceType === "builtin") {
      continue;
    }
    const pinnedDigest = digestBySkillId.get(skill.id);
    const artifactDigest = pinnedDigest ?? readStoredSkillActiveArtifactDigestSync(skill.id, workspaceId) ?? undefined;
    if (!artifactDigest) {
      continue;
    }
    // A rollout pin fixes new tasks to a SPECIFIC installation revision until the
    // rollout switches; unpinned assignments resolve to the highest ready revision.
    const rolloutPin = rolloutPinBySkillId.get(skill.id);
    let installation = rolloutPin
      ? readSkillInstallationByLockSync({ workspaceId, runtimeId: input.runtimeId, artifactDigest, revision: rolloutPin })
      : null;
    if (!installation || installation.status !== "ready") {
      installation = readHighestRevisionSkillInstallationSync({
        workspaceId,
        runtimeId: input.runtimeId,
        artifactDigest,
      });
    }
    if (!installation) {
      continue;
    }
    if (installation.status !== "ready") {
      continue;
    }
    entries.push({
      skillId: skill.id,
      skillName: skill.name,
      artifactDigest: installation.artifactDigest,
      installationId: installation.id,
      revision: installation.revision,
      status: installation.status,
      ...readReleaseLockDigest(installation.resolvedLockJson),
    });
  }

  return { workspaceId, runtimeId: input.runtimeId, resolvedAt: now, entries };
}

/**
 * Loads a task's persisted Skill execution snapshot, or resolves + persists one
 * on first prep. The snapshot is frozen once written: retries reuse it (guarded
 * by runtimeId) so a retried task reproduces the same revision even if the skill
 * was upgraded between attempts. Freshness of the pinned installations is
 * re-checked separately at prep time (fail-closed on degraded/rolled back).
 */
export function resolveOrLoadTaskSkillExecutionSnapshotSync(
  taskId: string,
  input: {
    workspaceId?: string;
    runtimeId: string;
    agentName: string | undefined;
    agentSkills: WorkspaceSkill[];
  },
): TaskSkillExecutionSnapshot {
  const persisted = readTaskSkillExecutionSnapshotSync(taskId);
  if (persisted && persisted.runtimeId === input.runtimeId && persisted.workspaceId === (input.workspaceId ?? "default")) {
    return persisted;
  }
  const resolved = resolveTaskSkillExecutionSnapshotSync(input);
  const wrote = writeTaskSkillExecutionSnapshotSync(taskId, resolved);
  if (!wrote) {
    // Another preparer won the first-write race (the DB write is IS NULL-gated):
    // use ITS frozen snapshot so both concurrent executors of the same task see
    // exactly the same revision instead of diverging on their own resolution.
    const winner = readTaskSkillExecutionSnapshotSync(taskId);
    if (winner) {
      return winner;
    }
  }
  return resolved;
}
