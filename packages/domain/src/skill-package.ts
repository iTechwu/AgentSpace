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
  capabilities?: DspCapability[];
  services?: DspServiceRef[];
  entrypoints?: DspEntrypoint[];
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

export interface DspEntrypoint {
  id: string;
  kind: "script";
  path: string;
  runtime: SkillEntrypointRuntime;
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

export type SkillComponentKind = "dependency" | "script" | "cli" | "mcp" | "service";

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
