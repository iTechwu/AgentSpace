// 内容产物 / 技能安装 / 审批 / 服务目录 / Pager / Git 凭据（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


export interface ContentBlobRecord {
  sha256: string;
  workspaceId: string;
  storageProvider: string;
  storageBucket?: string;
  storageRegion?: string;
  storageEndpoint?: string;
  storageKey: string;
  sizeBytes: number;
  mediaType: string;
  createdAt: string;
}

export type SkillArtifactSource =
  | "manual"
  | "github"
  | "skills.sh"
  | "clawhub"
  | "local"
  | "tos"
  | "legacy";

export interface SkillArtifactRecord {
  id: string;
  workspaceId: string;
  digest: string;
  skillId?: string;
  name: string;
  version: string;
  manifestVersion: number;
  manifestJson: string;
  sourceType: string;
  sourceUrl?: string;
  /** Stable logical coordinate (e.g. github:owner/repo/skills/name); nullable. */
  coordinate?: string;
  provenanceJson: string;
  fileCount: number;
  totalSizeBytes: number;
  legacyIncomplete: boolean;
  createdAt: string;
}

export interface SkillArtifactFileRecord {
  id: string;
  artifactId: string;
  workspaceId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  mode: string;
  isText: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Skill installations (artifact × runtime preparation)                */
/* ------------------------------------------------------------------ */

export type SkillInstallationComponentKind = "dependency" | "script" | "cli" | "mcp" | "service" | "egress";
export type SkillInstallationComponentStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "blocked"
  | "failed"
  | "degraded";
export type SkillInstallationOperationStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type SkillInstallationOperationType =
  | "inspect"
  | "prepare"
  | "verify"
  | "activate"
  | "deactivate"
  | "uninstall"
  | "upgrade"
  | "rollback";

export interface StoredSkillInstallationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  artifactDigest: string;
  status: string;
  resolvedLockJson: string;
  preparedPath?: string;
  preparedDigest?: string;
  health: string;
  previousReadyRevision?: string;
  previousReadyArtifactDigest?: string;
  rolloutPlanId?: string;
  revision: string;
  installedAt?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillInstallationComponentRecord {
  id: string;
  installationId: string;
  kind: SkillInstallationComponentKind;
  key: string;
  status: SkillInstallationComponentStatus;
  errorCode?: string;
  errorMessage?: string;
  lastOperationId?: string;
  verifiedAt?: string;
  updatedAt: string;
}

export interface PagerAlertStateRecord {
  id: string;
  workspaceId: string;
  alertKey: string;
  code: string;
  employeeName?: string;
  metric?: string;
  severity: string;
  status: "active" | "cleared";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  lastEscalatedAt?: string;
  clearedAt?: string;
}

export interface WorkspaceGitCredentialRecord {
  id: string;
  workspaceId: string;
  host: string;
  credentialType: "token" | "ssh_key";
  referenceName: string;
  /** Encrypted at rest; never returned to the UI. */
  encryptedSecret: string;
  /** sha256 hex of the plaintext — rotation/leak detection, non-secret. */
  fingerprint: string;
  status: "active" | "revoked";
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface SkillRunnerInvocationRecord {
  id: string;
  workspaceId: string;
  taskId?: string;
  runtimeId?: string;
  installationId?: string;
  skillId?: string;
  skillName: string;
  artifactDigest: string;
  revision?: string;
  entrypointId: string;
  entrypointKey: string;
  entrypointPath?: string;
  entrypointRuntime?: string;
  actorId: string;
  actorType: string;
  resultCode: number;
  timedOut: boolean;
  durationMs?: number;
  safeSummary?: string;
  eventId?: string;
  createdAt: string;
}

export interface SkillInstallApprovalRiskItem {
  category: "script" | "network" | "mcp_tool" | "write";
  key: string;
  description: string;
}

export interface SkillInstallApprovalRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  policyVersion: string;
  riskDecisionDigest: string;
  decision: "approved" | "rejected";
  riskItems: SkillInstallApprovalRiskItem[];
  reason?: string;
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface SkillRolloutPlanRecord {
  id: string;
  workspaceId: string;
  rootArtifactDigest: string;
  planDigest: string;
  policyVersion: string;
  closureJson: string;
  targetRuntimesJson: string;
  riskSummaryJson: string;
  decision: "pending" | "approved" | "rejected";
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface SkillUpgradeApprovalRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  fromDigest: string;
  toDigest: string;
  diffHash: string;
  policyVersion: string;
  decision: "approved" | "rejected";
  reason?: string;
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface StoredSkillInstallationOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  installationId: string;
  operation: SkillInstallationOperationType;
  status: SkillInstallationOperationStatus;
  requestSnapshotJson: string;
  safeResultJson: string;
  errorCode?: string;
  /** Lease expiry while claimed/running; null once completed/failed/pending. */
  leaseExpiresAt?: string;
  /** Monotonic fencing value incremented on every claim. */
  claimGeneration: number;
  errorMessage?: string;
  claimedAt?: string;
  completedAt?: string;
  requestedByUserId?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Skill support services (catalog + managed instance + binding)       */
/* ------------------------------------------------------------------ */

export interface StoredSkillServiceCatalogRecord {
  id: string;
  workspaceId: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  protocol: string;
  scope: string;
  resourcesJson: string;
  healthJson: string;
  networkJson: string;
  configSchemaVersion: number;
  configSchemaJson: string;
  secretFieldsJson: string;
  externalDependenciesJson: string;
  rollbackClass: string;
  templateDigest: string;
  sbomDigest?: string;
  runAsNonRoot: boolean;
  readOnlyRootfs: boolean;
  capDropJson: string;
  /** Cosign public key (PEM) trusted to sign this template's image, when enforced. */
  signatureKeyPem?: string;
  /** When true the managed node MUST verify the image signature before pulling. */
  signatureRequired: boolean;
  risk: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredManagedSkillServiceRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  catalogId: string;
  status: string;
  networkIdentity?: string;
  resourceProfileJson: string;
  lastHealth?: string;
  lastHealthAt?: string;
  rolloutRevision: string;
  /** Set by the retire sweep when the service first became unreferenced (rollback-cooldown window). */
  unreferencedSince?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillServiceBindingRecord {
  installationId: string;
  serviceId: string;
  catalogTemplateVersion: string;
  serviceImageDigest: string;
  endpointRef: string;
  healthRevision: string;
  configSchemaVersion: number;
  createdAt: string;
}

export interface ManagedSkillServiceOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  serviceId: string;
  installationId?: string;
  /** For a canary provision: the green managed service this instance replaces
   *  (the control plane switches bindings away from it on completion). */
  replacesServiceId?: string;
  operation: "provision" | "retire";
  status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
  errorCode?: string;
  errorMessage?: string;
  claimedAt?: string;
  completedAt?: string;
  leaseExpiresAt?: string;
  /** Monotonic fencing value incremented on every claim. */
  claimGeneration: number;
  createdAt: string;
}

export interface StoredWorkspaceServiceSecretRecord {
  id: string;
  workspaceId: string;
  serviceCatalogId: string;
  name: string;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
}
