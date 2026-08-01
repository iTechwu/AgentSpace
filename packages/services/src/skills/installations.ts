import {
  createSkillInstallationSync,
  completeSkillInstallationOperationSync as completeSkillOperationDbSync,
  failSkillInstallationOperationSync as failSkillOperationDbSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  readSkillInstallationByLockSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationOperationSync,
  readSkillInstallationSync,
  setSkillInstallationStatusSync,
  updateSkillInstallationComponentStatusSync,
  type SkillInstallationComponentInput,
  type StoredSkillInstallationOperationRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import type {
  ClaimedSkillInstallationOperation,
  SkillComponentKind,
  SkillComponentStatus,
  SkillInstallationOperationKind,
} from "@dofe-agent/domain";
import { createSkillInstallationOperationSync } from "@dofe-agent/db";
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
export function resolveClaimedSkillInstallationOperationSync(input: {
  workspaceId: string;
  operation: StoredSkillInstallationOperationRecord;
}): ClaimedSkillInstallationOperation | null {
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

  return {
    operationId: input.operation.id,
    workspaceId: input.operation.workspaceId,
    runtimeId: input.operation.runtimeId,
    installationId: installation.id,
    operation: input.operation.operation as SkillInstallationOperationKind,
    artifactDigest: artifact.digest,
    artifactName: artifact.name,
    files: fileRecords.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.sizeBytes,
      mediaType: file.mediaType,
      mode: file.mode,
    })),
    components: components.map((component) => ({
      kind: component.kind,
      key: component.key,
      status: component.status,
    })),
    createdAt: input.operation.createdAt,
  };
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

/** Task-time freshness gate: only a `ready` installation may enter a task. */
export function assertSkillInstallationReadyForTaskSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
}): { ok: true; installationId: string } | { ok: false; status: string; reason: string } {
  const installation = readSkillInstallationByLockSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
    revision: "v1",
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
  return { ok: true, installationId: installation.id };
}
