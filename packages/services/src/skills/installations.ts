import {
  createSkillInstallationSync,
  completeSkillInstallationOperationSync as completeSkillOperationDbSync,
  failSkillInstallationOperationSync as failSkillOperationDbSync,
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
  type ContentBlobRecord,
  type SkillInstallationComponentInput,
  type StoredSkillInstallationOperationRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import type {
  ClaimedSkillInstallationOperation,
  SkillComponentKind,
  SkillComponentStatus,
  SkillInstallationOperationKind,
  TaskSkillExecutionSnapshot,
} from "@dofe-agent/domain";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { createSkillInstallationOperationSync } from "@dofe-agent/db";
import { createAttachmentStorageClient, type AttachmentStorageReadInput } from "../attachments/storage.ts";
import { evaluateSkillInstallationCapabilitiesSync } from "./capabilities.ts";

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
  const resolvedLockJson = buildResolvedLockJson(artifact.digest, artifact.manifestVersion);

  const installation = createSkillInstallationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: artifact.digest,
    status: "preparing",
    components,
    resolvedLockJson,
  });

  createSkillInstallationOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    installationId: installation.id,
    operation: "prepare",
    requestedByUserId: input.requestedByUserId,
    requestSnapshotJson: JSON.stringify({ artifactDigest: artifact.digest, components: components.map((c) => c.key) }),
  });

  return installation;
}

function buildInstallationComponents(
  manifest: {
    dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
    entrypoints?: Array<{ path?: string }>;
    capabilities?: Array<{ kind?: string; catalogSlug?: string }>;
  },
  fileRecords: Array<{ path: string; mode: string }>,
): SkillInstallationComponentInput[] {
  const components: SkillInstallationComponentInput[] = [];

  // Manifest dependencies use `manager` (SkillDependencyDeclaration) or
  // `kind` (DspDependency); accept both for forward compatibility.
  for (const dependency of manifest.dependencies ?? []) {
    components.push({
      kind: "dependency",
      key: `${dependency.manager ?? dependency.kind}:${dependency.name}@${dependency.version}`,
    });
  }
  for (const entrypoint of manifest.entrypoints ?? []) {
    if (entrypoint.path) {
      components.push({ kind: "script", key: entrypoint.path });
    }
  }
  for (const file of fileRecords) {
    if (file.mode === "0755") {
      components.push({ kind: "script", key: file.path });
    }
  }
  for (const capability of manifest.capabilities ?? []) {
    const kind = capability.kind === "cli" ? "cli" : "mcp";
    components.push({ kind, key: `${kind}:${capability.catalogSlug}` });
  }

  // Package integrity is always a required component so an artifact with no
  // declared dependencies still goes through verification before `ready`.
  if (components.length === 0) {
    components.push({ kind: "dependency", key: "package:integrity" });
  }
  return components;
}

function buildResolvedLockJson(artifactDigest: string, packageSchemaVersion: number): string {
  return JSON.stringify({
    artifactDigest,
    packageSchemaVersion,
    dependencyLockDigest: "",
    serviceTemplateVersions: {},
    serviceImageDigests: {},
    serviceConfigSchemaVersions: {},
    mcpToolFingerprints: {},
    providerCompatibilityRevision: 0,
  });
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
  const components = readSkillInstallationComponentsSync(installation.id);
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
    components: components.map((component) => ({
      kind: component.kind,
      key: component.key,
      status: component.status,
    })),
    createdAt: input.operation.createdAt,
  };
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

export function completeSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  safeResultJson?: string;
  componentStatuses?: Array<{
    kind: SkillComponentKind;
    key: string;
    status: SkillComponentStatus;
    errorCode?: string;
    errorMessage?: string;
  }>;
}): boolean {
  const done = completeSkillOperationDbSync({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    safeResultJson: input.safeResultJson,
  });
  if (!done) {
    return false;
  }
  const operation = readSkillInstallationOperationSync(input.operationId, input.workspaceId);
  if (!operation) {
    return false;
  }
  for (const component of input.componentStatuses ?? []) {
    updateSkillInstallationComponentStatusSync({
      installationId: operation.installationId,
      kind: component.kind,
      key: component.key,
      status: component.status,
      errorCode: component.errorCode,
      errorMessage: component.errorMessage,
      verifiedAt: component.status === "ready" ? new Date().toISOString() : undefined,
      lastOperationId: operation.id,
    });
  }
  // Record the daemon-side materialized path (digest-keyed Runtime cache) so the
  // control plane can observe cache reuse and the concrete location on the node.
  if (input.safeResultJson) {
    try {
      const safeResult = JSON.parse(input.safeResultJson) as {
        preparedPath?: string;
        cacheHit?: boolean;
        computedDigest?: string;
      };
      if (typeof safeResult.preparedPath === "string" && safeResult.preparedPath.length > 0) {
        setSkillInstallationPreparedPathSync({
          installationId: operation.installationId,
          workspaceId: input.workspaceId,
          preparedPath: safeResult.preparedPath,
        });
      }
      if (typeof safeResult.computedDigest === "string") {
        setSkillInstallationPreparedDigestSync({
          installationId: operation.installationId,
          workspaceId: input.workspaceId,
          preparedDigest: safeResult.computedDigest,
        });
      }
    } catch {
      // Malformed safeResultJson must not fail completion; evidence is best-effort.
    }
  }
  evaluateSkillInstallationReadinessSync(operation.installationId, input.workspaceId);
  return true;
}

export function failSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode?: string;
  errorMessage: string;
}): boolean {
  const done = failSkillOperationDbSync({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
  if (!done) {
    return false;
  }
  const operation = readSkillInstallationOperationSync(input.operationId, input.workspaceId);
  if (operation) {
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
    evaluateSkillInstallationReadinessSync(operation.installationId, input.workspaceId);
  }
  return true;
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

  for (const skill of input.agentSkills) {
    if (skill.sourceType === "builtin") {
      continue;
    }
    const pinnedDigest = digestBySkillId.get(skill.id);
    const artifactDigest = pinnedDigest ?? readStoredSkillActiveArtifactDigestSync(skill.id, workspaceId) ?? undefined;
    if (!artifactDigest) {
      continue;
    }
    const installation = readHighestRevisionSkillInstallationSync({
      workspaceId,
      runtimeId: input.runtimeId,
      artifactDigest,
    });
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
  writeTaskSkillExecutionSnapshotSync(taskId, resolved);
  return resolved;
}
