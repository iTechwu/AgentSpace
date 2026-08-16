// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/openmontage` 子路径与根 re-export 使用。

export {
  listOpenMontageChannelProjectionVersionsSync,
  listOpenMontageSyncingJobIdsSync,
} from "@dofe-agent/db";

export {
  callOpenMontageJobActionAsync,
  dispatchOpenMontageProjectionNotificationSync,
  ingestSignedOpenMontageEventSync,
  reconcileOpenMontageJobAsync,
  reconcileSyncingOpenMontageJobsAsync,
  sanitizeOpenMontageEventForStorage,
  verifyOpenMontageEventRequest,
  OpenMontageEventAuthenticationError,
  OpenMontageEventValidationError,
  OpenMontageJobActionError,
  type OpenMontageJobActionInput,
  type VerifiedOpenMontageEventRequest,
} from "./events.ts";

export {
  issueOpenMontageArtifactReadGrant,
  issueOpenMontageArtifactWriteGrant,
  publishOpenMontageArtifactUpload,
  resolveOpenMontageArtifactReadDownload,
  OpenMontageArtifactAuthenticationError,
  OpenMontageArtifactConfigurationError,
  OpenMontageArtifactValidationError,
  type OpenMontageArtifactReadDownload,
  type OpenMontageArtifactReadGrantDocument,
  type OpenMontageArtifactWriteGrantDocument,
  type OpenMontageOutputArtifactMetadata,
  type OpenMontagePublishedArtifactDocument,
} from "./artifacts.ts";

export {
  bindOpenMontageJobDelegationAsync,
  drainOrphanedOpenMontageDelegationsAsync,
  drainPendingOpenMontageJobDelegationsAsync,
  drainOpenMontageJobDelegationAsync,
  issueOpenMontageModelCredential,
  OpenMontageDelegationAuthenticationError,
  OpenMontageDelegationConfigurationError,
  OpenMontageDelegationValidationError,
  type BindOpenMontageJobDelegationInput,
  type CreateDelegationRequest,
  type OpenMontageDelegationIntentStore,
  type OpenMontageModelCredentialDocument,
} from "./delegations.ts";

export {
  assertOpenMontageMcpPurgeableAsync,
  assertOpenMontageMcpPurgeableSync,
  assertOpenMontageRuntimePurgeableAsync,
  assertOpenMontageRuntimePurgeableSync,
  OpenMontagePurgeBlockedError,
} from "./purge-guard.ts";
