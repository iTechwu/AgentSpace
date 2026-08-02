import { createHash } from "node:crypto";
import {
  cancelUnfinishedSkillInstallationOperationsSync,
  consumeSkillUpgradeApprovalSync,
  createSkillInstallationOperationSync,
  createSkillInstallationSync,
  createSkillUpgradeApprovalSync,
  getDatabase,
  readMcpCatalogItemBySlugSync,
  readSkillArtifactByDigestSync,
  readSkillInstallationSync,
  readSkillInstallationByLockSync,
  readSkillServiceCatalogSync,
  readSkillUpgradeApprovalByLockSync,
  readSkillUpgradeApprovalSync,
  resolveSkillIdForArtifactDigestSync,
  setActiveArtifactDigestForSkillSync,
  setAssignmentArtifactDigestsForSkillSync,
  setSkillInstallationStatusSync,
  withTransaction,
  type SkillArtifactRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import { buildSkillInstallationComponentsSync } from "./installations.ts";
import { buildSkillOperationRequestSnapshotJson } from "./installations-protocol.ts";
import { stableStringify } from "./package/package-digest.ts";

/**
 * Version model (Phase 4): version labels are for humans; tasks, audit and
 * rollback only use immutable locked values (05-运维服务与版本治理.md §4).
 */

export interface ResolvedSkillReleaseLock {
  artifactDigest: string;
  packageSchemaVersion: number;
  dependencyLockDigest: string;
  serviceTemplateVersions: Record<string, string>;
  serviceImageDigests: Record<string, string>;
  serviceConfigSchemaVersions: Record<string, number>;
  mcpToolFingerprints: Record<string, string>;
  providerCompatibilityRevision: number;
  /** sha256 of the canonical (stable-sorted) JSON of the eight lock fields above. */
  lockDigest: string;
  /**
   * Required services/MCP capabilities whose catalog entry is missing, so the
   * lock could NOT pin them. An installation whose lock has unresolved required
   * entries must never reach `ready` (fail-closed). NOT part of the lockDigest.
   */
  unresolvedRequired: string[];
}

/**
 * Resolves the FULL immutable release lock for an artifact (05-运维服务与版本治理.md
 * §4). Reproducible: the same artifact + catalog state always yields the same
 * `lockDigest`, independent of provenance. Service image/config-schema values are
 * read from `skill_service_catalog` by (slug, templateVersion); MCP tool
 * fingerprints are derived deterministically from the catalog item's declared
 * tools. Entries whose catalog row is missing are left out of the lock (a
 * required-but-unresolvable service is later blocked by its service component,
 * not here). No provider-compatibility model exists yet, so
 * `providerCompatibilityRevision` stays 0.
 */
export function computeSkillReleaseLockSync(
  artifact: SkillArtifactRecord,
  workspaceId = "default",
): ResolvedSkillReleaseLock {
  const manifest = parseManifest(artifact.manifestJson);
  const dependencies = manifest.dependencies ?? [];
  const dependencyLockDigest = createHash("sha256")
    .update(stableStringify(dependencies.map((dep) => `${dep.manager ?? dep.kind}:${dep.name}@${dep.version}`)))
    .digest("hex");

  const serviceTemplateVersions: Record<string, string> = {};
  const serviceImageDigests: Record<string, string> = {};
  const serviceConfigSchemaVersions: Record<string, number> = {};
  const unresolvedRequired: string[] = [];
  for (const service of manifest.services ?? []) {
    if (!service.catalogSlug || !service.templateVersion) {
      continue;
    }
    serviceTemplateVersions[service.catalogSlug] = service.templateVersion;
    const catalog = readSkillServiceCatalogSync(service.catalogSlug, service.templateVersion, workspaceId);
    if (catalog) {
      if (catalog.imageDigest) {
        serviceImageDigests[service.catalogSlug] = catalog.imageDigest;
      }
      if (typeof catalog.configSchemaVersion === "number") {
        serviceConfigSchemaVersions[service.catalogSlug] = catalog.configSchemaVersion;
      }
    } else if (service.required !== false) {
      // A required service that cannot be pinned by the catalog is a hard blocker
      // (fail-closed: the installation must never reach ready without it).
      unresolvedRequired.push(`service:${service.catalogSlug}`);
    }
  }

  const mcpToolFingerprints: Record<string, string> = {};
  for (const capability of manifest.capabilities ?? []) {
    if (capability.kind !== "mcp" || !capability.catalogSlug) {
      continue;
    }
    const fingerprint = computeMcpToolFingerprint(capability.catalogSlug, workspaceId);
    if (fingerprint) {
      mcpToolFingerprints[capability.catalogSlug] = fingerprint;
    } else {
      // Every declared MCP capability must be pinned by the catalog to be usable.
      unresolvedRequired.push(`mcp:${capability.catalogSlug}`);
    }
  }

  const lockWithoutDigest = {
    artifactDigest: artifact.digest,
    packageSchemaVersion: artifact.manifestVersion,
    dependencyLockDigest,
    serviceTemplateVersions,
    serviceImageDigests,
    serviceConfigSchemaVersions,
    mcpToolFingerprints,
    providerCompatibilityRevision: 0,
  };
  const lockDigest = createHash("sha256").update(stableStringify(lockWithoutDigest)).digest("hex");
  return { ...lockWithoutDigest, lockDigest, unresolvedRequired };
}

/**
 * History reconstruction (05-运维服务与版本治理.md §历史重建): proves an
 * installation's release state is fully reproducible from the immutable
 * artifact + catalog state alone. Recomputes the lock from the stored artifact
 * and compares the lockDigest against the one recorded at install time; a match
 * means the old revision can be re-derived even if the original source
 * (Git/registry) is gone.
 */
export function verifySkillInstallationLockReconstructableSync(
  installationId: string,
  workspaceId = "default",
): boolean {
  const installation = readSkillInstallationSync(installationId, workspaceId);
  if (!installation) {
    return false;
  }
  const artifact = readSkillArtifactByDigestSync(installation.artifactDigest, workspaceId);
  if (!artifact) {
    return false;
  }
  const recomputed = computeSkillReleaseLockSync(artifact, workspaceId);
  try {
    const stored = JSON.parse(installation.resolvedLockJson) as { lockDigest?: unknown };
    return typeof stored.lockDigest === "string" && stored.lockDigest === recomputed.lockDigest;
  } catch {
    return false;
  }
}

function computeMcpToolFingerprint(catalogSlug: string, workspaceId: string): string | undefined {
  const catalog = readMcpCatalogItemBySlugSync(catalogSlug, workspaceId);
  if (!catalog) {
    return undefined;
  }
  try {
    const declaredTools = JSON.parse(catalog.declaredToolsJson) as unknown;
    return createHash("sha256").update(stableStringify(declaredTools)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Reads a stored installation's release lock; returns null when absent or unparseable. */
export function readSkillInstallationLockSync(
  installationId: string,
  workspaceId = "default",
): ResolvedSkillReleaseLock | null {
  const installation = readSkillInstallationSync(installationId, workspaceId);
  if (!installation || !installation.resolvedLockJson) {
    return null;
  }
  try {
    return JSON.parse(installation.resolvedLockJson) as ResolvedSkillReleaseLock;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Semantic diff                                                       */
/* ------------------------------------------------------------------ */

export type SkillDiffCategory = "content" | "execution" | "network_permissions" | "services" | "config";

export interface SkillReleaseDiff {
  categories: Array<{
    category: SkillDiffCategory;
    breaking: boolean;
    changes: string[];
  }>;
  breaking: boolean;
}

interface ManifestLike {
  schemaVersion?: number;
  artifact?: { name?: string; version?: string };
  files?: Array<{ path?: string; sha256?: string; mode?: string }>;
  dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
  capabilities?: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }>;
  services?: Array<{ catalogSlug?: string; templateVersion?: string; required?: boolean }>;
  entrypoints?: Array<{ id?: string; kind?: string; path?: string; runtime?: string }>;
}

function parseManifest(json: string): ManifestLike {
  try {
    return JSON.parse(json) as ManifestLike;
  } catch {
    return {};
  }
}

/**
 * Diffs two artifact manifests grouped into the five categories of the design
 * (05-运维服务与版本治理.md §5.1). Any executable, capability, service, config
 * or dependency change is breaking and requires re-approval; content-only
 * (docs/assets) changes are not.
 */
export function diffSkillArtifactsSync(input: {
  fromManifestJson: string;
  toManifestJson: string;
}): SkillReleaseDiff {
  const from = parseManifest(input.fromManifestJson);
  const to = parseManifest(input.toManifestJson);

  const categories: SkillReleaseDiff["categories"] = [];

  // content: non-executable file changes only; executable content changes are
  // reclassified as execution changes below because they are breaking.
  const { contentChanges, executableContentChanges } = diffFiles(
    from.files ?? [],
    to.files ?? [],
  );
  categories.push({ category: "content", breaking: false, changes: contentChanges });

  // execution: entrypoints + executable-mode scripts + executable content changes
  const executionChanges: string[] = [];
  executionChanges.push(...executableContentChanges);
  const fromEntrypoints = from.entrypoints ?? [];
  const toEntrypoints = to.entrypoints ?? [];
  for (const entrypoint of toEntrypoints) {
    if (!fromEntrypoints.some((existing) => existing.id === entrypoint.id)) {
      executionChanges.push(`entrypoint added: ${entrypoint.id} (${entrypoint.path ?? ""})`);
    }
  }
  for (const entrypoint of fromEntrypoints) {
    if (!toEntrypoints.some((existing) => existing.id === entrypoint.id)) {
      executionChanges.push(`entrypoint removed: ${entrypoint.id} (${entrypoint.path ?? ""})`);
    }
  }
  for (const [path, fromMode, toMode] of diffExecutableModes(from.files ?? [], to.files ?? [])) {
    executionChanges.push(`script mode changed: ${path} ${fromMode} → ${toMode}`);
  }
  const fromExecutables = new Set((from.files ?? []).filter((file) => file.mode === "0755").map((file) => file.path ?? ""));
  const toExecutables = new Set((to.files ?? []).filter((file) => file.mode === "0755").map((file) => file.path ?? ""));
  for (const path of toExecutables) {
    if (!fromExecutables.has(path)) {
      executionChanges.push(`executable added: ${path}`);
    }
  }
  for (const path of fromExecutables) {
    if (!toExecutables.has(path)) {
      executionChanges.push(`executable removed: ${path}`);
    }
  }
  categories.push({ category: "execution", breaking: executionChanges.length > 0, changes: executionChanges });

  // network/permissions: capabilities
  const capabilityChanges = diffCapabilities(from.capabilities ?? [], to.capabilities ?? []);
  categories.push({ category: "network_permissions", breaking: capabilityChanges.length > 0, changes: capabilityChanges });

  // services
  const serviceChanges = diffServices(from.services ?? [], to.services ?? []);
  categories.push({ category: "services", breaking: serviceChanges.length > 0, changes: serviceChanges });

  // config: schemaVersion + dependencies
  const configChanges: string[] = [];
  if (from.schemaVersion !== to.schemaVersion) {
    configChanges.push(`package schema version: ${from.schemaVersion ?? "-"} → ${to.schemaVersion ?? "-"}`);
  }
  const fromDeps = from.dependencies ?? [];
  const toDeps = to.dependencies ?? [];
  for (const dep of toDeps) {
    if (!fromDeps.some((existing) => sameDependency(existing, dep))) {
      configChanges.push(`dependency added: ${depKey(dep)}`);
    }
  }
  for (const dep of fromDeps) {
    if (!toDeps.some((existing) => sameDependency(existing, dep))) {
      configChanges.push(`dependency removed: ${depKey(dep)}`);
    }
  }
  categories.push({ category: "config", breaking: configChanges.length > 0, changes: configChanges });

  return {
    categories,
    breaking: categories.some((category) => category.breaking && category.changes.length > 0),
  };
}

function diffFiles(
  from: Array<{ path?: string; sha256?: string; mode?: string }>,
  to: Array<{ path?: string; sha256?: string; mode?: string }>,
): { contentChanges: string[]; executableContentChanges: string[] } {
  const changes: string[] = [];
  const executableChanges: string[] = [];
  const fromByPath = new Map(from.map((file) => [file.path ?? "", file]));
  const toByPath = new Map(to.map((file) => [file.path ?? "", file]));

  const executablePaths = new Set(
    [...from, ...to]
      .filter((file) => file.mode === "0755")
      .map((file) => file.path ?? ""),
  );

  for (const [path, toFile] of toByPath) {
    const fromFile = fromByPath.get(path);
    if (!fromFile) {
      changes.push(`file added: ${path}`);
    } else if (fromFile.sha256 !== toFile.sha256) {
      if (executablePaths.has(path)) {
        executableChanges.push(`executable content changed: ${path}`);
      } else {
        changes.push(`file modified: ${path}`);
      }
    }
  }
  for (const path of fromByPath.keys()) {
    if (!toByPath.has(path)) {
      changes.push(`file removed: ${path}`);
    }
  }
  return {
    contentChanges: changes.sort(),
    executableContentChanges: executableChanges.sort(),
  };
}

function diffExecutableModes(
  from: Array<{ path?: string; mode?: string }>,
  to: Array<{ path?: string; mode?: string }>,
): Array<[string, string, string]> {
  const fromByPath = new Map(from.map((file) => [file.path ?? "", file.mode ?? "0644"]));
  const toByPath = new Map(to.map((file) => [file.path ?? "", file.mode ?? "0644"]));
  const changes: Array<[string, string, string]> = [];
  for (const [path, toMode] of toByPath) {
    const fromMode = fromByPath.get(path);
    if (fromMode && fromMode !== toMode) {
      changes.push([path, fromMode, toMode]);
    }
  }
  return changes.sort((left, right) => left[0].localeCompare(right[0]));
}

function diffCapabilities(
  from: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }>,
  to: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }>,
): string[] {
  const changes: string[] = [];
  const fromBySlug = new Map(from.map((capability) => [capability.catalogSlug ?? "", capability]));
  const toBySlug = new Map(to.map((capability) => [capability.catalogSlug ?? "", capability]));
  for (const [slug, toCap] of toBySlug) {
    const fromCap = fromBySlug.get(slug);
    if (!fromCap) {
      changes.push(`capability added: ${toCap.kind}:${slug}`);
    } else {
      if (fromCap.kind !== toCap.kind) {
        changes.push(`capability kind changed: ${slug} ${fromCap.kind ?? "-"} → ${toCap.kind ?? "-"}`);
      }
      const fromTools = new Set(fromCap.requiredTools ?? []);
      const toTools = new Set(toCap.requiredTools ?? []);
      for (const tool of toTools) {
        if (!fromTools.has(tool)) {
          changes.push(`required tool added: ${slug}:${tool}`);
        }
      }
      for (const tool of fromTools) {
        if (!toTools.has(tool)) {
          changes.push(`required tool removed: ${slug}:${tool}`);
        }
      }
    }
  }
  for (const slug of fromBySlug.keys()) {
    if (!toBySlug.has(slug)) {
      changes.push(`capability removed: ${slug}`);
    }
  }
  return changes.sort();
}

function diffServices(
  from: Array<{ catalogSlug?: string; templateVersion?: string; required?: boolean }>,
  to: Array<{ catalogSlug?: string; templateVersion?: string; required?: boolean }>,
): string[] {
  const changes: string[] = [];
  const fromBySlug = new Map(from.map((service) => [service.catalogSlug ?? "", service]));
  const toBySlug = new Map(to.map((service) => [service.catalogSlug ?? "", service]));
  for (const [slug, toService] of toBySlug) {
    const fromService = fromBySlug.get(slug);
    if (!fromService) {
      changes.push(`service added: ${slug}@${toService.templateVersion ?? ""}`);
    } else {
      if (fromService.templateVersion !== toService.templateVersion) {
        changes.push(`service template changed: ${slug} ${fromService.templateVersion ?? "-"} → ${toService.templateVersion ?? "-"}`);
      }
      if (fromService.required !== toService.required) {
        changes.push(`service required flag changed: ${slug} ${fromService.required ?? "-"} → ${toService.required ?? "-"}`);
      }
    }
  }
  for (const slug of fromBySlug.keys()) {
    if (!toBySlug.has(slug)) {
      changes.push(`service removed: ${slug}`);
    }
  }
  return changes.sort();
}

function sameDependency(
  left: { manager?: string; kind?: string; name?: string; version?: string },
  right: { manager?: string; kind?: string; name?: string; version?: string },
): boolean {
  return depKey(left) === depKey(right);
}

function depKey(dep: { manager?: string; kind?: string; name?: string; version?: string }): string {
  return `${dep.manager ?? dep.kind}:${dep.name}@${dep.version}`;
}

/** True when the diff contains any breaking category change. */
export function isSkillUpgradeApprovalRequiredSync(diff: SkillReleaseDiff): boolean {
  return diff.breaking;
}

/** sha256 of the canonical semantic diff — the immutable fingerprint an approval binds to. */
export function computeSkillUpgradeDiffHashSync(input: {
  fromManifestJson: string;
  toManifestJson: string;
}): string {
  const diff = diffSkillArtifactsSync(input);
  return createHash("sha256").update(stableStringify(diff)).digest("hex");
}

/**
 * Records an immutable upgrade-approval decision bound to the exact
 * (fromDigest, toDigest, diffHash). A changed diff or digest invalidates it —
 * `createSkillUpgradePlanSync` re-derives the diff hash and requires a matching
 * unconsumed record before a breaking upgrade proceeds.
 */
export function approveSkillUpgradeSync(input: {
  workspaceId?: string;
  skillId?: string;
  fromDigest: string;
  toDigest: string;
  diffHash: string;
  decision?: "approved" | "rejected";
  reason?: string;
  actorUserId?: string;
}): { approvalId: string; created: boolean } {
  const approval = createSkillUpgradeApprovalSync({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    fromDigest: input.fromDigest,
    toDigest: input.toDigest,
    diffHash: input.diffHash,
    decision: input.decision ?? "approved",
    reason: input.reason,
    actorUserId: input.actorUserId,
  });
  return { approvalId: approval.id, created: !approval.consumedAt };
}

/* ------------------------------------------------------------------ */
/* Upgrade & rollback                                                  */
/* ------------------------------------------------------------------ */

/**
 * Creates a candidate installation for a new artifact on a runtime, linked to
 * the previous ready installation so rollback can reactivate it. Queues a
 * prepare operation; readiness is only reached after daemon verification.
 */
export function createSkillUpgradePlanSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
  previousReadyInstallationId: string;
  requestedByUserId?: string;
  /**
   * A previously-recorded immutable approval (created via `approveSkillUpgradeSync`).
   * Required when the semantic diff is breaking; the approval is consumed
   * atomically with the plan creation.
   */
  approvalId?: string;
}): StoredSkillInstallationRecord {
  const workspaceId = input.workspaceId ?? "default";
  const previous = readSkillInstallationSync(input.previousReadyInstallationId, workspaceId);
  if (!previous) {
    throw new Error(`Previous ready installation "${input.previousReadyInstallationId}" does not exist.`);
  }
  if (previous.status !== "ready") {
    throw new Error(`Previous installation is "${previous.status}", not ready; cannot upgrade from it.`);
  }
  if (previous.runtimeId !== input.runtimeId) {
    throw new Error(`Previous installation is on runtime "${previous.runtimeId}", not "${input.runtimeId}"; upgrade must stay on the same runtime.`);
  }

  const artifact = readSkillArtifactByDigestSync(input.artifactDigest, workspaceId);
  if (!artifact) {
    throw new Error(`Skill artifact "${input.artifactDigest}" does not exist in this workspace.`);
  }
  const previousArtifact = readSkillArtifactByDigestSync(previous.artifactDigest, workspaceId);
  assertSameSkillLineage(previousArtifact, previous.artifactDigest, artifact, input.artifactDigest, workspaceId);

  // Breaking upgrades require an unconsumed immutable approval bound to the
  // exact (fromDigest, toDigest, diffHash); it is consumed atomically with plan
  // creation so it cannot be reused for a different upgrade.
  const diff = diffSkillArtifactsSync({
    fromManifestJson: previousArtifact?.manifestJson ?? "{}",
    toManifestJson: artifact.manifestJson,
  });
  const diffHash = computeSkillUpgradeDiffHashSync({
    fromManifestJson: previousArtifact?.manifestJson ?? "{}",
    toManifestJson: artifact.manifestJson,
  });
  if (diff.breaking) {
    if (!input.approvalId) {
      throw new Error("This upgrade contains breaking changes and requires an explicit approval.");
    }
    const approval = readSkillUpgradeApprovalSync(input.approvalId, workspaceId);
    if (!approval) {
      throw new Error(`Approval "${input.approvalId}" does not exist.`);
    }
    if (approval.decision !== "approved") {
      throw new Error("The recorded approval decision is not 'approved'.");
    }
    if (
      approval.fromDigest !== previous.artifactDigest ||
      approval.toDigest !== input.artifactDigest ||
      approval.diffHash !== diffHash
    ) {
      throw new Error("Approval does not match this upgrade's from/to digest + diff hash; a new approval is required.");
    }
    if (approval.consumedAt) {
      throw new Error("Approval has already been consumed by another upgrade.");
    }
  }

  const revision = nextRevision(previous.revision);
  const components = buildSkillInstallationComponentsSync({ workspaceId, artifactDigest: input.artifactDigest });

  withTransaction(getDatabase(), () => {
    if (diff.breaking && input.approvalId) {
      const consumed = consumeSkillUpgradeApprovalSync(input.approvalId, workspaceId);
      if (!consumed) {
        throw new Error("Approval was concurrently consumed; retry with a fresh approval.");
      }
    }
  });

  const lock = computeSkillReleaseLockSync(artifact, workspaceId);
  const installation = createSkillInstallationSync({
    workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
    // Fail-closed: unresolved required services/MCP capabilities block the candidate.
    status: lock.unresolvedRequired.length > 0 ? "blocked" : "preparing",
    revision,
    previousReadyRevision: previous.revision,
    previousReadyArtifactDigest: previous.artifactDigest,
    resolvedLockJson: JSON.stringify(lock),
    components,
  });

  createSkillInstallationOperationSync({
    workspaceId,
    runtimeId: input.runtimeId,
    installationId: installation.id,
    operation: "prepare",
    requestedByUserId: input.requestedByUserId,
    requestSnapshotJson: buildSkillOperationRequestSnapshotJson({
      artifactDigest: input.artifactDigest,
      expectedComponents: components.map((component) => ({ kind: component.kind, key: component.key })),
      extra: { upgradeFrom: previous.artifactDigest },
    }),
  });

  return installation;
}

function assertSameSkillLineage(
  previousArtifact: SkillArtifactRecord | null,
  fromDigest: string,
  toArtifact: SkillArtifactRecord,
  toDigest: string,
  workspaceId: string,
): void {
  const fromSkillId = previousArtifact?.skillId ?? resolveSkillIdForArtifactDigestSync(fromDigest, workspaceId);
  const toSkillId = toArtifact.skillId ?? resolveSkillIdForArtifactDigestSync(toDigest, workspaceId);
  if (fromSkillId && toSkillId && fromSkillId !== toSkillId) {
    throw new Error(`Upgrade crosses skill lineage (${fromSkillId} → ${toSkillId}); refusing to upgrade across skills.`);
  }
  if (fromSkillId && !toSkillId) {
    throw new Error("Upgrade target artifact is not bound to a skill lineage.");
  }
}

function nextRevision(revision: string): string {
  const match = revision.match(/^v(\d+)$/);
  if (!match) {
    return "v2";
  }
  return `v${Number(match[1]) + 1}`;
}

/**
 * Rollback reactivates the previous READY installation revision — it never
 * re-downloads old branches. Sets the skill's active digest back to the
 * previous revision's artifact so new tasks resolve to the rolled-back state.
 */
export function rollbackSkillInstallationSync(input: {
  installationId: string;
  workspaceId?: string;
  skillId?: string;
}): { ok: boolean; previousReadyDigest?: string; reason?: string } {
  const current = readSkillInstallationSync(input.installationId, input.workspaceId);
  if (!current) {
    return { ok: false, reason: `Installation "${input.installationId}" does not exist.` };
  }
  if (!current.previousReadyRevision || !current.previousReadyArtifactDigest) {
    return { ok: false, reason: "Installation has no previous ready revision to roll back to." };
  }
  const previous = readSkillInstallationByLockSync({
    workspaceId: input.workspaceId,
    runtimeId: current.runtimeId,
    artifactDigest: current.previousReadyArtifactDigest,
    revision: current.previousReadyRevision,
  });
  if (!previous) {
    return { ok: false, reason: `Previous ready revision "${current.previousReadyRevision}" is missing.` };
  }
  if (previous.status !== "ready") {
    return { ok: false, reason: `Previous revision is "${previous.status}", not ready; cannot roll back.` };
  }

  const skillId =
    input.skillId
    ?? readSkillArtifactByDigestSync(current.artifactDigest, input.workspaceId)?.skillId
    ?? resolveSkillIdForArtifactDigestSync(current.artifactDigest, input.workspaceId ?? "default");
  if (!skillId) {
    return { ok: false, reason: "Cannot determine skill id for rollback; pass skillId explicitly." };
  }

  const db = getDatabase();
  withTransaction(db, () => {
    // Stop any in-flight work on the failing installation.
    cancelUnfinishedSkillInstallationOperationsSync({
      installationId: current.id,
      workspaceId: input.workspaceId,
    });

    // Degrade the failing current installation so it no longer enters tasks.
    setSkillInstallationStatusSync({
      installationId: current.id,
      workspaceId: input.workspaceId,
      status: "degraded",
      health: "rolled_back",
    });

    // Reactivate the previous revision's artifact on the skill row and on every
    // employee assignment so new tasks resolve to the rolled-back state.
    setActiveArtifactDigestForSkillSync({
      skillId,
      digest: previous.artifactDigest,
      workspaceId: input.workspaceId,
    });
    setAssignmentArtifactDigestsForSkillSync({
      skillId,
      digest: previous.artifactDigest,
      workspaceId: input.workspaceId,
    });
  });

  return { ok: true, previousReadyDigest: previous.artifactDigest };
}
