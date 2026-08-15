/**
 * Dofe Skill Package (DSP) v1 domain contract.
 *
 * Introduces an immutable artifact model for Skills, layered on top of the
 * Agent Skills `SKILL.md` directory baseline. See
 * docs/0801/skill-install/02-架构设计.md and 06-实施计划.md.
 *
 * Phase 0 only defines the contract (types + status machines + error codes).
 * It does NOT change the existing mutable `WorkspaceSkill` storage model —
 * the legacy model continues to work; new tables and projection paths are
 * layered on top in later phases.
 */

/** Canonical artifact digest prefix. */
export const SKILL_ARTIFACT_DIGEST_PREFIX = "sha256:" as const;

/**
 * `.dofe/manifest.json` — platform metadata that cannot be safely expressed
 * in Markdown. The upstream `SKILL.md` is never rewritten by the platform.
 */
export interface DspManifest {
  schemaVersion: number;
  artifact: DspArtifactMeta;
  files: DspFileEntry[];
  dependencies?: DspDependency[];
  /** Skill→Skill dependencies (a skill depends on another skill's output/execution). */
  skillDependencies?: SkillSkillDependency[];
  capabilities?: DspCapability[];
  services?: DspServiceRef[];
  entrypoints?: DspEntrypoint[];
  /**
   * Egress declaration. Omit for no egress (Runner runs `--network none`). An
   * empty `network: {}` means unrestricted egress (highest risk); a non-empty
   * `egressAllowlist` limits egress to those hosts (DNS-poison + /etc/hosts
   * pinning). Any egress requires first-install risk approval before the Runner
   * is granted a network other than `none`.
   */
  network?: DspNetworkEgress;
}

/**
 * Network egress declaration on a skill manifest. Presence of this field opts
 * the skill into runtime egress; the actual grant is gated on first-install
 * approval (see install-approval risk items) and re-verified at task time.
 */
export interface DspNetworkEgress {
  /** Hostnames the skill may contact; empty/absent under a present `network` = unrestricted. */
  egressAllowlist?: string[];
}

export interface DspArtifactMeta {
  name: string;
  /** SemVer release label for human communication; execution uses digest. */
  version: string;
  /** Filled by the validator after hashing; ignored when submitted. */
  sha256?: string;
}

export interface DspFileEntry {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  /** POSIX mode string e.g. "0644" / "0755"; defaults to "0644". */
  mode?: string;
}

export type SkillDependencyKind = "npm" | "pip" | "uv" | "system";

export interface DspDependency {
  kind: SkillDependencyKind;
  name: string;
  /** Exact version (SemVer for npm, PEP 440 for pip/uv). */
  version: string;
  /** Subresource integrity, e.g. "sha512-..." for npm. */
  integrity?: string;
}

/**
 * Where a Skill→Skill dependency must be satisfied relative to the dependent.
 * - `same_runtime`: the dependent directly invokes it; both must be co-located
 *   on the same Runtime.
 * - `workflow`: only requires an executable node to exist in the Workflow; it
 *   need not be installed on the dependent's Runtime.
 */
export type SkillSkillPlacement = "same_runtime" | "workflow";

/**
 * A Skill→Skill dependency. `coordinate` is a STABLE logical identity (must
 * carry a scheme prefix, e.g. `github:owner/repo/skills/novel-outline`) and
 * never a renameable display name. `version` is a range the AUTHOR declares;
 * the install plan must resolve it to an exact artifact digest.
 */
export interface SkillSkillDependency {
  coordinate: string;
  /** Author-declared version range (e.g. "^1.1.0"); resolved to a digest at install time. */
  version: string;
  placement: SkillSkillPlacement;
  /** Optional dependencies may be skipped explicitly; defaults to required. */
  required: boolean;
}

export type SkillCapabilityKind = "mcp" | "cli";

export interface DspCapability {
  kind: SkillCapabilityKind;
  /** References an MCP Center catalog slug or a Runtime App catalog slug. */
  catalogSlug: string;
  /** Tools that must be covered by an approved, ready connection. */
  requiredTools?: string[];
}

export interface DspServiceRef {
  catalogSlug: string;
  templateVersion: string;
  required: boolean;
}

export type SkillEntrypointRuntime = "node" | "python" | "bash";

/**
 * Infers the entrypoint runtime from a script file extension. This is the
 * single source of truth for IMPLICIT entrypoints (executable files without a
 * declared entrypoint): the provider projection, install verification and
 * system-dependency probing must all agree on it, otherwise a skill would be
 * probed in one Runner image and executed in another.
 */
export function inferSkillEntrypointRuntimeForPath(path: string): SkillEntrypointRuntime | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts") || lower.endsWith(".mts")) return "node";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  return undefined;
}

/**
 * The distinct set of runtimes a skill executes in: declared entrypoint
 * runtimes plus runtimes inferred from executable ("0755") files without a
 * declared entrypoint — mirroring the provider projection, which turns such
 * files into implicit Runner entrypoints. System-dependency probing must cover
 * exactly this set.
 */
export function collectSkillManifestRuntimes(manifest: {
  entrypoints?: Array<{ runtime?: string; path?: string }>;
  files?: Array<{ path?: string; mode?: string }>;
}): SkillEntrypointRuntime[] {
  const seen = new Set<SkillEntrypointRuntime>();
  // A file that is a DECLARED entrypoint carries its own explicit runtime, so
  // its extension must NOT be re-inferred: run.py declared as bash must not
  // additionally pull in the python Runner image + python deps. Record the
  // declared entrypoint paths first and exclude them from implicit inference.
  const declaredPaths = new Set<string>();
  for (const entrypoint of manifest.entrypoints ?? []) {
    if (entrypoint.runtime === "node" || entrypoint.runtime === "python" || entrypoint.runtime === "bash") {
      seen.add(entrypoint.runtime);
    }
    if (entrypoint.path) {
      declaredPaths.add(entrypoint.path);
    }
  }
  const inferredPaths = new Set<string>();
  for (const file of manifest.files ?? []) {
    if (file.mode !== "0755" || !file.path || declaredPaths.has(file.path) || inferredPaths.has(file.path)) continue;
    inferredPaths.add(file.path);
    const runtime = inferSkillEntrypointRuntimeForPath(file.path);
    if (runtime) {
      seen.add(runtime);
    }
  }
  return Array.from(seen);
}

export interface DspEntrypoint {
  id: string;
  kind: "script";
  path: string;
  runtime: SkillEntrypointRuntime;
  /** Task-resolved config/secret keys exposed only through a short-lived read-only JSON file. */
  configKeys?: string[];
}

/** Stable executable name used by provider projections and the daemon broker. */
export function buildSkillRunnerCommandName(skillName: string, skillId: string, entrypointId: string): string {
  const skillSegment = normalizeSkillRunnerCommandSegment(skillName).slice(0, 54);
  const entrypointSegment = normalizeSkillRunnerCommandSegment(entrypointId).slice(0, 28);
  const scopeHash = stableCommandHash(`${skillId}\0${entrypointId}`);
  const skillSuffix = normalizeSkillRunnerCommandSegment(skillId).slice(-8);
  return `dofe-skill-${skillSegment}-${entrypointSegment}-${scopeHash}-${skillSuffix}`;
}

export function normalizeSkillRunnerCommandSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "entrypoint";
}

function stableCommandHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Risk classification assigned by inspection/scanning. */
export type SkillArtifactRisk = "unknown" | "low" | "medium" | "high";

/**
 * A resolved, immutable skill artifact. `digest` is the canonical content
 * address (sha256 over canonical manifest + sorted file digests); source
 * provenance is kept separate and never feeds the digest.
 */
export interface SkillArtifact {
  digest: string;
  workspaceId: string;
  name: string;
  version: string;
  description: string;
  manifest: DspManifest;
  schemaVersion: number;
  /** github | skills.sh | clawhub | local | tos | manual | runtime | catalog */
  sourceType: string;
  sourceUrl?: string;
  /** Immutable locked ref: commit SHA / registry digest. */
  resolvedRef?: string;
  /** Original user-submitted URL (mutable branch/tag allowed here). */
  originalUrl?: string;
  risk: SkillArtifactRisk;
  scanVersion: string;
  fileCount: number;
  totalSizeBytes: number;
  createdAt: string;
}

/**
 * Installation lifecycle. `ready` strictly means: artifact verified + every
 * required component verified on the target Runtime. Anything missing is
 * `blocked`, never "best effort".
 *
 * See 01-产品方案.md §4 state machine.
 */
export type SkillInstallationStatus =
  | "inspecting"
  | "approval_required"
  | "preparing"
  | "blocked"
  | "ready"
  | "degraded"
  | "retired";

export type SkillComponentKind = "dependency" | "script" | "cli" | "mcp" | "service" | "egress";

export type SkillComponentStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "blocked"
  | "failed"
  | "degraded";

/**
 * The immutable release lock. Version labels are for humans; tasks, audit and
 * rollback only ever use these locked values. See 05-运维服务与版本治理.md §4.
 */
export interface SkillReleaseLock {
  artifactDigest: string;
  packageSchemaVersion: number;
  dependencyLockDigest: string;
  serviceTemplateVersions: Record<string, string>;
  serviceImageDigests: Record<string, string>;
  serviceConfigSchemaVersions: Record<string, number>;
  mcpToolFingerprints: Record<string, string>;
  /** Exact immutable MCP catalog releases used to derive the tool fingerprints. */
  mcpCatalogReleases?: Record<string, {
    catalogItemId: string;
    version: string;
    toolFingerprint: string;
  }>;
  providerCompatibilityRevision: number;
  /** sha256 of the canonical (stable-sorted) JSON of the fields above. */
  lockDigest: string;
  /** Required services/MCP capabilities the lock could NOT pin; non-empty → installation must stay blocked. */
  unresolvedRequired?: string[];
}

/**
 * Kinds of daemon-executed skill installation operations. Mirrors the MCP
 * connection operation protocol (see daemon-api.ts) but for artifact×runtime
 * installation work.
 */
export type SkillInstallationOperationKind =
  | "inspect"
  | "prepare"
  | "verify"
  | "activate"
  | "deactivate"
  | "uninstall"
  | "upgrade"
  | "rollback";

/** A file the daemon must materialize/verify, sourced from the immutable artifact. */
export interface SkillInstallationOperationFile {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  mode: string;
  /** Short-lived signed URL for remote daemons to download the blob. */
  downloadUrl?: string;
  /** Local storage path (e.g. `local:///...` or `tos://...`) for fallback/direct access. */
  storedPath?: string;
}

/** One-time authenticated payload delivered to the daemon on claim. */
/** A component identity the daemon must report on for an operation, fixed at creation. */
export interface SkillInstallationOperationExpectedComponent {
  kind: SkillComponentKind;
  key: string;
}

/** Daemon-reported status for one expected component, with optional failure detail. */
export interface SkillInstallationOperationComponentStatus {
  kind: SkillComponentKind;
  key: string;
  status: SkillComponentStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface ClaimedSkillInstallationOperation {
  operationId: string;
  claimGeneration: number;
  workspaceId: string;
  runtimeId: string;
  installationId: string;
  operation: SkillInstallationOperationKind;
  artifactDigest: string;
  artifactName: string;
  /** Canonical manifest JSON so the daemon can recompute the root digest. */
  manifestJson: string;
  /** sha256 of the release lock the installation was created against (audit handle; daemon verification is future). */
  releaseLockDigest?: string;
  files: SkillInstallationOperationFile[];
  /**
   * The FROZEN expected component set for this operation (from the operation's
   * request snapshot), NOT the live DB status list. `status` is informational —
   * the control plane synthesizes `"pending"` for the expected set; the daemon's
   * component verifier reads only `kind`/`key`.
   */
  components: Array<{ kind: SkillComponentKind; key: string; status: string }>;
  createdAt: string;
}

export interface ClaimSkillInstallationOperationResponse {
  operation: ClaimedSkillInstallationOperation | null;
}

export interface StartSkillInstallationOperationRequest {
  claimGeneration: number;
  status?: "running";
}

export interface CompleteSkillInstallationOperationRequest {
  claimGeneration: number;
  /** Daemon evidence; the control plane requires a parseable `computedDigest` equal to the artifact digest (fail-closed). */
  safeResultJson?: string;
  /** Must be EXACTLY the operation's expected component set — no unknown, duplicate, or missing components. */
  componentStatuses?: SkillInstallationOperationComponentStatus[];
}

export interface FailSkillInstallationOperationRequest {
  claimGeneration: number;
  errorCode?: string;
  errorMessage: string;
  /** Optional partial component statuses (subset of the expected set) to persist before the remainder is blocked. */
  componentStatuses?: SkillInstallationOperationComponentStatus[];
}

/**
 * One skill's frozen execution pin inside a task snapshot. Captured at task prep
 * time so a running task always materializes the same artifact revision even if
 * the skill is upgraded or rolled back mid-flight (02-架构设计.md §6).
 */
export interface TaskSkillExecutionSnapshotEntry {
  skillId: string;
  skillName: string;
  artifactDigest: string;
  installationId: string;
  revision: string;
  /** Installation status at snapshot resolution time (typically "ready"). */
  status: string;
  /** sha256 of the release lock the installation was created against (audit handle). */
  releaseLockDigest?: string;
  /** True when the pinned installation owns a daemon-local dependency env. */
  dependencyEnvironmentRequired?: boolean;
  /**
   * Frozen runtime egress grant for this skill, resolved once at snapshot time.
   * Absent = no egress (Runner runs `--network none`). A non-empty list limits
   * egress to those hostnames (DNS poison + /etc/hosts pinning). The sentinel
   * `["*"]` means an approved unrestricted grant (Runner gets full network
   * egress). Only stamped when an approved first-install risk decision covering
   * the manifest's `network` declaration is re-verified against this entry's
   * release lock — so a revoked approval collapses back to no egress.
   */
  egressAllowlist?: string[];
}

/**
 * Immutable per-task record of which skill-installation revisions a task was
 * prepared against. Persisted on the task (`agent_task_queue.skill_execution_snapshot_json`)
 * for retry reproducibility and in-flight audit.
 */
export interface TaskSkillExecutionSnapshot {
  workspaceId: string;
  runtimeId: string;
  /** ISO timestamp when the snapshot was resolved. */
  resolvedAt: string;
  entries: TaskSkillExecutionSnapshotEntry[];
}

/** Deployment type for a managed support service. */
export type SkillServiceDeploymentType =
  | "external_connection"
  | "managed_service"
  | "platform_shared";

export type SkillServiceRollbackClass =
  | "stateless"
  | "backward_compatible"
  | "irreversible_migration";

/**
 * Package validation / inspection error codes. Stable identifiers surfaced to
 * the UI; the inspection panel must never fail silently.
 */
export type SkillPackageErrorCode =
  | "SKILL_MD_MISSING"
  | "FRONTMATTER_INVALID"
  | "MANIFEST_INVALID"
  | "PATH_TRAVERSAL"
  | "ABSOLUTE_PATH"
  | "UNDECLARED_SYMLINK"
  | "MAX_FILES_EXCEEDED"
  | "ARCHIVE_TOO_LARGE"
  | "UNCOMPRESSED_LIMIT"
  | "NESTING_TOO_DEEP"
  | "DIGEST_MISMATCH"
  | "BINARY_UNREADABLE"
  | "DUPLICATE_PATH"
  | "EMPTY_PACKAGE";
