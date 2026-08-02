import { createHash } from "node:crypto";
import {
  cancelUnfinishedSkillInstallationOperationsSync,
  createSkillInstallationOperationSync,
  createSkillInstallationSync,
  getDatabase,
  readSkillArtifactByDigestSync,
  readSkillInstallationSync,
  readSkillInstallationByLockSync,
  setActiveArtifactDigestForSkillSync,
  setAssignmentArtifactDigestsForSkillSync,
  setSkillInstallationStatusSync,
  withTransaction,
  type SkillArtifactRecord,
  type StoredSkillInstallationRecord,
} from "@dofe-agent/db";
import { buildSkillInstallationComponentsSync } from "./installations.ts";
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
}

export function computeSkillReleaseLockSync(artifact: SkillArtifactRecord): ResolvedSkillReleaseLock {
  const manifest = parseManifest(artifact.manifestJson);
  const dependencies = manifest.dependencies ?? [];
  const dependencyLockDigest = createHash("sha256")
    .update(stableStringify(dependencies.map((dep) => `${dep.manager ?? dep.kind}:${dep.name}@${dep.version}`)))
    .digest("hex");

  const serviceTemplateVersions: Record<string, string> = {};
  const serviceConfigSchemaVersions: Record<string, number> = {};
  for (const service of manifest.services ?? []) {
    if (service.catalogSlug && service.templateVersion) {
      serviceTemplateVersions[service.catalogSlug] = service.templateVersion;
    }
  }

  return {
    artifactDigest: artifact.digest,
    packageSchemaVersion: artifact.manifestVersion,
    dependencyLockDigest,
    serviceTemplateVersions,
    serviceImageDigests: {},
    serviceConfigSchemaVersions,
    mcpToolFingerprints: {},
    providerCompatibilityRevision: 0,
  };
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
}): StoredSkillInstallationRecord {
  const previous = readSkillInstallationSync(input.previousReadyInstallationId, input.workspaceId);
  if (!previous) {
    throw new Error(`Previous ready installation "${input.previousReadyInstallationId}" does not exist.`);
  }
  const revision = nextRevision(previous.revision);
  const components = buildSkillInstallationComponentsSync({ workspaceId: input.workspaceId, artifactDigest: input.artifactDigest });

  const installation = createSkillInstallationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
    status: "preparing",
    revision,
    previousReadyRevision: previous.revision,
    previousReadyArtifactDigest: previous.artifactDigest,
    resolvedLockJson: "{}",
    components,
  });

  createSkillInstallationOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    installationId: installation.id,
    operation: "prepare",
    requestedByUserId: input.requestedByUserId,
    requestSnapshotJson: JSON.stringify({ artifactDigest: input.artifactDigest, upgradeFrom: previous.artifactDigest }),
  });

  return installation;
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

  const skillId = input.skillId ?? readSkillArtifactByDigestSync(current.artifactDigest, input.workspaceId)?.skillId;
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
