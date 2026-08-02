import { createHash } from "node:crypto";
import {
  cancelUnfinishedSkillInstallationOperationsSync,
  consumeSkillUpgradeApprovalSync,
  createSkillInstallationOperationSync,
  createSkillInstallationSync,
  createSkillUpgradeApprovalSync,
  getDatabase,
  listSkillIdsForArtifactDigestSync,
  listMcpCatalogItemReleasesSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemReleaseSync,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  readSkillInstallationSync,
  readSkillInstallationByLockSync,
  readSkillInstallationComponentsSync,
  readSkillServiceCatalogSync,
  readSkillUpgradeApprovalByLockSync,
  readSkillUpgradeApprovalSync,
  setSkillInstallationStatusSync,
  upsertSkillArtifactBindingSync,
  withTransaction,
  type SkillArtifactRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import {
  buildSkillInstallationComponentsSync,
  queueDeclaredSkillServicesForInstallationSync,
} from "./installations.ts";
import { evaluateSkillInstallationCapabilitiesSync } from "./capabilities.ts";
import { readSkillArtifactTextProjectionSync, verifySkillArtifactIntegritySync } from "./skill-artifacts.ts";
import { buildSkillOperationRequestSnapshotJson } from "./installations-protocol.ts";
import { stableStringify } from "./package/package-digest.ts";
import {
  deleteWorkspaceSkillFileSync,
  readWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
} from "./skills.ts";
import { parseSkillMetadata } from "./skill-metadata.ts";
import { sameValue } from "../shared/helpers.ts";

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
  mcpCatalogReleases: Record<string, McpCatalogReleaseLock>;
  providerCompatibilityRevision: number;
  /** sha256 of the canonical (stable-sorted) JSON of the immutable lock fields above. */
  lockDigest: string;
  /**
   * Required services/MCP capabilities whose catalog entry is missing, so the
   * lock could NOT pin them. An installation whose lock has unresolved required
   * entries must never reach `ready` (fail-closed). NOT part of the lockDigest.
   */
  unresolvedRequired: string[];
}

export interface McpCatalogReleaseLock {
  catalogItemId: string;
  version: string;
  toolFingerprint: string;
}

export interface SkillRollbackPreflightIssue {
  code:
    | "artifact_missing"
    | "artifact_integrity_failed"
    | "prepared_digest_mismatch"
    | "installation_component_not_ready";
  message: string;
  componentKind?: string;
  componentKey?: string;
}

export const SKILL_UPGRADE_POLICY_VERSION = "v1";
export const SKILL_PROVIDER_COMPATIBILITY_REVISION = 1;

/**
 * Resolves the FULL immutable release lock for an artifact (05-运维服务与版本治理.md
 * §4). Reproducible: the same artifact + catalog state always yields the same
 * `lockDigest`, independent of provenance. Service image/config-schema values are
 * read from `skill_service_catalog` by (slug, templateVersion); MCP tool
 * fingerprints are derived deterministically from the catalog item's declared
 * tools. Entries whose catalog row is missing are left out of the lock (a
 * required-but-unresolvable service is later blocked by its service component,
 * not here). `providerCompatibilityRevision` identifies the platform projection
 * contract used to build the lock and must change when that contract changes.
 */
export function computeSkillReleaseLockSync(
  artifact: SkillArtifactRecord,
  workspaceId = "default",
): ResolvedSkillReleaseLock {
  return computeSkillReleaseLockInternal(artifact, workspaceId);
}

function computeSkillReleaseLockInternal(
  artifact: SkillArtifactRecord,
  workspaceId: string,
  pinnedMcpReleases?: Record<string, McpCatalogReleaseLock>,
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
  const mcpCatalogReleases: Record<string, McpCatalogReleaseLock> = {};
  for (const capability of manifest.capabilities ?? []) {
    if (capability.kind !== "mcp" || !capability.catalogSlug) {
      continue;
    }
    const pinned = pinnedMcpReleases?.[capability.catalogSlug];
    const catalog = pinned
      ? readMcpCatalogItemReleaseSync(capability.catalogSlug, pinned.version, workspaceId)
      : readMcpCatalogItemBySlugSync(capability.catalogSlug, workspaceId);
    const fingerprint = catalog ? computeMcpToolFingerprint(catalog.declaredToolsJson) : undefined;
    if (
      catalog
      && fingerprint
      && (!pinned || (catalog.id === pinned.catalogItemId && fingerprint === pinned.toolFingerprint))
    ) {
      mcpToolFingerprints[capability.catalogSlug] = fingerprint;
      mcpCatalogReleases[capability.catalogSlug] = {
        catalogItemId: catalog.id,
        version: catalog.version,
        toolFingerprint: fingerprint,
      };
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
    mcpCatalogReleases,
    providerCompatibilityRevision: SKILL_PROVIDER_COMPATIBILITY_REVISION,
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
  try {
    const stored = JSON.parse(installation.resolvedLockJson) as Partial<ResolvedSkillReleaseLock>;
    if (typeof stored.lockDigest !== "string") {
      return false;
    }
    const pinnedReleases = isMcpCatalogReleaseLockMap(stored.mcpCatalogReleases)
      ? stored.mcpCatalogReleases
      : resolveLegacyMcpReleasePins(stored.mcpToolFingerprints, workspaceId);
    if (!pinnedReleases) {
      return false;
    }
    const recomputed = computeSkillReleaseLockInternal(artifact, workspaceId, pinnedReleases);
    if (stored.mcpCatalogReleases) {
      return stored.lockDigest === recomputed.lockDigest;
    }
    return stored.lockDigest === computeLegacyLockDigest(recomputed);
  } catch {
    return false;
  }
}

function computeMcpToolFingerprint(declaredToolsJson: string): string | undefined {
  try {
    const declaredTools = JSON.parse(declaredToolsJson) as unknown;
    return createHash("sha256").update(stableStringify(declaredTools)).digest("hex");
  } catch {
    return undefined;
  }
}

function resolveLegacyMcpReleasePins(
  fingerprints: Record<string, string> | undefined,
  workspaceId: string,
): Record<string, McpCatalogReleaseLock> | null {
  const resolved: Record<string, McpCatalogReleaseLock> = {};
  for (const [slug, expectedFingerprint] of Object.entries(fingerprints ?? {})) {
    const release = listMcpCatalogItemReleasesSync(slug, workspaceId).find(
      (candidate) => computeMcpToolFingerprint(candidate.declaredToolsJson) === expectedFingerprint,
    );
    if (!release) {
      return null;
    }
    resolved[slug] = {
      catalogItemId: release.id,
      version: release.version,
      toolFingerprint: expectedFingerprint,
    };
  }
  return resolved;
}

function isMcpCatalogReleaseLockMap(value: unknown): value is Record<string, McpCatalogReleaseLock> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const lock = entry as Partial<McpCatalogReleaseLock>;
    return typeof lock.catalogItemId === "string"
      && typeof lock.version === "string"
      && typeof lock.toolFingerprint === "string";
  });
}

function computeLegacyLockDigest(lock: ResolvedSkillReleaseLock): string {
  const {
    lockDigest: _lockDigest,
    unresolvedRequired: _unresolvedRequired,
    mcpCatalogReleases: _mcpCatalogReleases,
    ...legacyFields
  } = lock;
  return createHash("sha256").update(stableStringify(legacyFields)).digest("hex");
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
    policyVersion: SKILL_UPGRADE_POLICY_VERSION,
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
  assertSameSkillLineage(previous.artifactDigest, input.artifactDigest, workspaceId);

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
      approval.diffHash !== diffHash ||
      approval.policyVersion !== SKILL_UPGRADE_POLICY_VERSION
    ) {
      throw new Error("Approval does not match this upgrade's from/to digest, diff hash, and policy version; a new approval is required.");
    }
    if (approval.consumedAt) {
      throw new Error("Approval has already been consumed by another upgrade.");
    }
  }

  const revision = nextRevision(previous.revision);
  const components = buildSkillInstallationComponentsSync({ workspaceId, artifactDigest: input.artifactDigest });

  const lock = computeSkillReleaseLockSync(artifact, workspaceId);
  return withTransaction(getDatabase(), () => {
    if (diff.breaking && input.approvalId) {
      const consumed = consumeSkillUpgradeApprovalSync(
        input.approvalId,
        workspaceId,
        SKILL_UPGRADE_POLICY_VERSION,
      );
      if (!consumed) {
        throw new Error("Approval was concurrently consumed; retry with a fresh approval.");
      }
    }

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

    queueDeclaredSkillServicesForInstallationSync({
      workspaceId,
      runtimeId: input.runtimeId,
      installationId: installation.id,
      manifestJson: artifact.manifestJson,
    });

    return installation;
  });
}

function assertSameSkillLineage(
  fromDigest: string,
  toDigest: string,
  workspaceId: string,
): void {
  const fromSkillIds = listSkillIdsForArtifactDigestSync(fromDigest, workspaceId);
  const toSkillIds = listSkillIdsForArtifactDigestSync(toDigest, workspaceId);
  if (fromSkillIds.length === 0 || toSkillIds.length === 0) {
    throw new Error("Upgrade source and target artifacts must both be bound to a skill lineage.");
  }
  if (!fromSkillIds.some((skillId) => toSkillIds.includes(skillId))) {
    throw new Error(
      `Upgrade crosses skill lineage (${fromSkillIds.join(",")} -> ${toSkillIds.join(",")}); refusing to upgrade across skills.`,
    );
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
 * Promotes a verified candidate with a compare-and-swap cutover. The immutable
 * candidate may be prepared long before this call; no active assignment moves
 * until every preflight succeeds in the same transaction.
 */
export function promoteSkillUpgradeSync(input: {
  installationId: string;
  skillId: string;
  expectedPreviousDigest: string;
  workspaceId?: string;
}): { ok: true; artifactDigest: string; revision: string; assignmentCount: number } {
  const workspaceId = input.workspaceId ?? "default";
  const candidate = readSkillInstallationSync(input.installationId, workspaceId);
  if (!candidate) {
    throw new Error(`Candidate installation "${input.installationId}" does not exist.`);
  }
  if (candidate.status !== "ready") {
    throw new Error(`Candidate installation is "${candidate.status}", not ready; cannot promote.`);
  }
  if (candidate.previousReadyArtifactDigest !== input.expectedPreviousDigest || !candidate.previousReadyRevision) {
    throw new Error("Candidate previous digest does not match the expected active digest.");
  }
  const previous = readSkillInstallationByLockSync({
    workspaceId,
    runtimeId: candidate.runtimeId,
    artifactDigest: input.expectedPreviousDigest,
    revision: candidate.previousReadyRevision,
  });
  if (!previous || previous.status !== "ready") {
    throw new Error("Previous installation is no longer ready; refusing promotion.");
  }
  if (!verifySkillInstallationLockReconstructableSync(candidate.id, workspaceId)) {
    throw new Error("Candidate release lock is no longer reconstructable; refusing promotion.");
  }
  assertSameSkillLineage(input.expectedPreviousDigest, candidate.artifactDigest, workspaceId);
  const candidateSkillIds = listSkillIdsForArtifactDigestSync(candidate.artifactDigest, workspaceId);
  if (!candidateSkillIds.includes(input.skillId)) {
    throw new Error(`Skill "${input.skillId}" is not bound to the candidate artifact lineage.`);
  }
  const candidateArtifact = readSkillArtifactByDigestSync(candidate.artifactDigest, workspaceId);
  if (!candidateArtifact) {
    throw new Error("Candidate artifact is missing; refusing promotion.");
  }
  const candidateProjection = readSkillArtifactTextProjectionSync(candidateArtifact);
  const candidateMarkdown = candidateProjection.find((file) => sameValue(file.path, "SKILL.md"))?.content;
  if (!candidateMarkdown) {
    throw new Error("Candidate artifact text projection is missing SKILL.md; refusing promotion.");
  }
  const candidateMetadata = parseSkillMetadata(candidateMarkdown, candidateArtifact.name);
  const candidateProvenance = parseRecord(candidateArtifact.provenanceJson);
  const candidateConfig = candidateProvenance && typeof candidateProvenance.skillConfig === "object"
    ? JSON.stringify(candidateProvenance.skillConfig)
    : undefined;
  const candidateDescription = typeof candidateProvenance?.skillDescription === "string"
    ? candidateProvenance.skillDescription
    : candidateMetadata.description;

  return withTransaction(getDatabase(), () => {
    const activeUpdated = getDatabase().prepare(
      `UPDATE skill SET active_artifact_digest = ?
       WHERE id = ? AND workspace_id = ? AND active_artifact_digest = ?`,
    ).run(candidate.artifactDigest, input.skillId, workspaceId, input.expectedPreviousDigest);
    if (activeUpdated.changes !== 1) {
      throw new Error("Skill active digest changed concurrently; reload the upgrade state and retry.");
    }

    const drift = getDatabase().prepare(
      `SELECT COUNT(*)::int AS count FROM agent_skill
       WHERE workspace_id = ? AND skill_id = ?
         AND skill_artifact_digest IS NOT NULL AND skill_artifact_digest <> ?`,
    ).get(workspaceId, input.skillId, input.expectedPreviousDigest) as { count: number };
    if (Number(drift.count) > 0) {
      throw new Error("One or more Skill assignments changed concurrently; promotion was not applied.");
    }
    const assignments = getDatabase().prepare(
      `UPDATE agent_skill
       SET skill_artifact_digest = ?, rollout_pin = ?
       WHERE workspace_id = ? AND skill_id = ?`,
    ).run(candidate.artifactDigest, candidate.revision, workspaceId, input.skillId);
    upsertSkillArtifactBindingSync({ workspaceId, skillId: input.skillId, digest: candidate.artifactDigest });
    synchronizePromotedSkillProjection({
      workspaceId,
      skillId: input.skillId,
      description: candidateDescription,
      sourceType: candidateArtifact.sourceType,
      sourceUrl: candidateArtifact.sourceUrl,
      configJson: candidateConfig,
      files: candidateProjection,
    });
    return {
      ok: true as const,
      artifactDigest: candidate.artifactDigest,
      revision: candidate.revision,
      assignmentCount: assignments.changes,
    };
  });
}

function synchronizePromotedSkillProjection(input: {
  workspaceId: string;
  skillId: string;
  description: string;
  sourceType: string;
  sourceUrl?: string;
  configJson?: string;
  files: Array<{ path: string; content: string }>;
}): void {
  const current = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!current) throw new Error(`Skill "${input.skillId}" does not exist.`);
  updateWorkspaceSkillSync({
    skillId: input.skillId,
    name: current.name,
    description: input.description,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    ...(input.configJson ? { configJson: input.configJson } : {}),
  }, input.workspaceId);
  for (const file of input.files) {
    upsertWorkspaceSkillFileSync({
      skillId: input.skillId,
      path: file.path,
      content: file.content,
    }, input.workspaceId);
  }
  const expectedPaths = new Set(input.files.map((file) => file.path.toLocaleLowerCase("en-US")));
  const refreshed = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  for (const file of refreshed?.files ?? []) {
    if (!expectedPaths.has(file.path.toLocaleLowerCase("en-US")) && !sameValue(file.path, "SKILL.md")) {
      deleteWorkspaceSkillFileSync(input.skillId, file.id, input.workspaceId);
    }
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
}): { ok: boolean; previousReadyDigest?: string; reason?: string; preflight?: SkillRollbackPreflightIssue[] } {
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
  if (!verifySkillInstallationLockReconstructableSync(previous.id, input.workspaceId ?? "default")) {
    return { ok: false, reason: "Previous revision release lock is no longer reconstructable; cannot roll back." };
  }

  const workspaceId = input.workspaceId ?? "default";
  const currentSkillIds = listSkillIdsForArtifactDigestSync(current.artifactDigest, workspaceId);
  const previousSkillIds = listSkillIdsForArtifactDigestSync(previous.artifactDigest, workspaceId);
  const commonSkillIds = currentSkillIds.filter((skillId) => previousSkillIds.includes(skillId));
  const skillId = input.skillId ?? (commonSkillIds.length === 1 ? commonSkillIds[0] : undefined);
  if (!skillId) {
    return { ok: false, reason: "Cannot determine one shared skill lineage for rollback; pass skillId explicitly." };
  }
  if (!currentSkillIds.includes(skillId) || !previousSkillIds.includes(skillId)) {
    return { ok: false, reason: `Skill "${skillId}" is not bound to both rollback revisions.` };
  }
  const activeDigest = readActiveArtifactDigestForSkillSync(skillId, workspaceId);
  if (activeDigest !== current.artifactDigest) {
    return { ok: false, reason: "The installation is not the current active digest; refusing stale rollback." };
  }
  const preflight = inspectSkillRollbackTargetSync(previous, workspaceId);
  if (preflight.length > 0) {
    return {
      ok: false,
      reason: preflight[0]!.message,
      preflight,
    };
  }

  const db = getDatabase();
  try {
    withTransaction(db, () => {
      const assignmentDrift = db.prepare(
        `SELECT COUNT(*)::int AS count FROM agent_skill
         WHERE workspace_id = ? AND skill_id = ?
           AND skill_artifact_digest IS NOT NULL AND skill_artifact_digest <> ?`,
      ).get(workspaceId, skillId, current.artifactDigest) as { count: number };
      if (Number(assignmentDrift.count) > 0) {
        throw new SkillReleaseConflictError("Skill assignments changed concurrently; refusing rollback.");
      }
      const switched = db.prepare(
        `UPDATE skill SET active_artifact_digest = ?
         WHERE id = ? AND workspace_id = ? AND active_artifact_digest = ?`,
      ).run(previous.artifactDigest, skillId, workspaceId, current.artifactDigest);
      if (switched.changes !== 1) {
        throw new SkillReleaseConflictError("Skill active digest changed concurrently; refusing rollback.");
      }

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

      // Restore every assignment and its strict revision pin.
      db.prepare(
        `UPDATE agent_skill SET skill_artifact_digest = ?, rollout_pin = ?
         WHERE workspace_id = ? AND skill_id = ?`,
      ).run(previous.artifactDigest, previous.revision, workspaceId, skillId);
      upsertSkillArtifactBindingSync({ workspaceId, skillId, digest: previous.artifactDigest });
    });
  } catch (error) {
    if (error instanceof SkillReleaseConflictError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }

  return { ok: true, previousReadyDigest: previous.artifactDigest };
}

function inspectSkillRollbackTargetSync(
  installation: StoredSkillInstallationRecord,
  workspaceId: string,
): SkillRollbackPreflightIssue[] {
  const artifact = readSkillArtifactByDigestSync(installation.artifactDigest, workspaceId);
  if (!artifact) {
    return [{
      code: "artifact_missing",
      message: `Rollback artifact "${installation.artifactDigest}" is missing.`,
    }];
  }
  let integrity: ReturnType<typeof verifySkillArtifactIntegritySync>;
  try {
    integrity = verifySkillArtifactIntegritySync(artifact);
  } catch {
    return [{
      code: "artifact_integrity_failed",
      message: "Rollback artifact storage could not be read for integrity verification.",
    }];
  }
  if (!integrity.ok) {
    return [{
      code: "artifact_integrity_failed",
      message: `Rollback artifact failed integrity verification (missing=${integrity.missing.length}, mismatched=${integrity.mismatched.length}, rootDigestMatches=${integrity.rootDigestMatches}).`,
    }];
  }
  if (installation.preparedDigest !== installation.artifactDigest) {
    return [{
      code: "prepared_digest_mismatch",
      message: "Rollback installation no longer has preparation evidence for the requested artifact digest.",
    }];
  }

  evaluateSkillInstallationCapabilitiesSync({
    installationId: installation.id,
    workspaceId,
    runtimeId: installation.runtimeId,
    artifactDigest: installation.artifactDigest,
  });
  return readSkillInstallationComponentsSync(installation.id)
    .filter((component) => component.status !== "ready")
    .map((component) => ({
      code: "installation_component_not_ready" as const,
      message: `Rollback component "${component.kind}:${component.key}" is "${component.status}", not ready.`,
      componentKind: component.kind,
      componentKey: component.key,
    }));
}

class SkillReleaseConflictError extends Error {}
