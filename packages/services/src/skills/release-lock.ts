import { createHash } from "node:crypto";
import {
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemReleaseSync,
  readSkillServiceCatalogSync,
  type SkillArtifactRecord,
} from "@dofe-agent/db";
import { stableStringify } from "./package/package-digest.ts";
import { computeMcpToolFingerprint, type McpCatalogReleaseLock } from "./mcp-release-lock.ts";

/**
 * Immutable release-lock computation, kept in its own module (depending only on
 * the DB layer and pure helpers) so skills/installations.ts can resolve locks
 * without importing skills/release.ts (release.ts imports installation
 * builders back from installations.ts, which used to form a module cycle).
 */

export interface ResolvedSkillReleaseLock {
  artifactDigest: string;
  packageSchemaVersion: number;
  dependencyLockDigest: string;
  /** sha256 over the declared (coordinate@version) Skill→Skill dependencies. */
  skillDependencyLockDigest: string;
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

export const SKILL_PROVIDER_COMPATIBILITY_REVISION = 2;

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

export function computeSkillReleaseLockInternal(
  artifact: SkillArtifactRecord,
  workspaceId: string,
  pinnedMcpReleases?: Record<string, McpCatalogReleaseLock>,
): ResolvedSkillReleaseLock {
  const manifest = parseManifest(artifact.manifestJson);
  const dependencies = manifest.dependencies ?? [];
  const dependencyLockDigest = createHash("sha256")
    .update(stableStringify(dependencies.map((dep) => `${dep.manager ?? dep.kind}:${dep.name}@${dep.version}`)))
    .digest("hex");

  // Lock the AUTHOR-declared Skill→Skill dependencies (coordinate + version range).
  // The RESOLVED digest closure is not part of the per-artifact lock — it depends
  // on the workspace's imported artifacts and is captured in skill_rollout_plan.
  const skillDependencyLockDigest = createHash("sha256")
    .update(stableStringify((manifest.skillDependencies ?? []).map((dep) => `${dep.coordinate}@${dep.version}`)))
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
    skillDependencyLockDigest,
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

export function computeLegacyLockDigest(lock: ResolvedSkillReleaseLock): string {
  const {
    lockDigest: _lockDigest,
    unresolvedRequired: _unresolvedRequired,
    mcpCatalogReleases: _mcpCatalogReleases,
    ...legacyFields
  } = lock;
  return createHash("sha256").update(stableStringify(legacyFields)).digest("hex");
}

export interface ManifestLike {
  schemaVersion?: number;
  artifact?: { name?: string; version?: string };
  files?: Array<{ path?: string; sha256?: string; mode?: string }>;
  dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
  skillDependencies?: Array<{ coordinate?: string; version?: string; placement?: string; required?: boolean }>;
  capabilities?: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }>;
  services?: Array<{ catalogSlug?: string; templateVersion?: string; required?: boolean }>;
  entrypoints?: Array<{ id?: string; kind?: string; path?: string; runtime?: string; configKeys?: string[] }>;
}

export function parseManifest(json: string): ManifestLike {
  try {
    return JSON.parse(json) as ManifestLike;
  } catch {
    return {};
  }
}
