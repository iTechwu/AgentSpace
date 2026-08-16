// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  type ExternalChannelBindingRecord,
  type ExternalDataOperationRunRecord,
  type ExternalIntegrationHealthStatus,
  type ExternalIntegrationEventRecord,
  type ExternalIntegrationRecord,
  type ExternalIntegrationTransportMode,
  type ExternalMessageMappingRecord,
  type ExternalMessageOutboxRecord,
  type ExternalResourceBindingRecord,
  type ExternalThreadBindingRecord,
  type ExternalUserBindingRecord
} from "@dofe-agent/db";
import {
  type FeishuAgentBotChannelAutoProvisioningInput,
  type FeishuAgentBotExternalGuestPolicyInput,
  type FeishuChannelAutoProvisionPolicy,
  type FeishuExternalParticipantPolicy,
  type FeishuApiClient
} from "@dofe-agent/services";

export const FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FEISHU_SMOKE_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const FEISHU_CLI_PLACEHOLDERS = {
  publicAppUrl: "CHANGE_ME_PUBLIC_DOFE_AGENT_URL",
  integrationId: "CHANGE_ME_FEISHU_INTEGRATION_ID",
  dofeAgentChannel: "CHANGE_ME_DOFE_AGENT_CHANNEL",
  agentName: "CHANGE_ME_AGENT_NAME",
  secondAgentName: "CHANGE_ME_SECOND_AGENT_NAME",
  dofeAgentUserId: "CHANGE_ME_DOFE_AGENT_USER_ID",
  approvalId: "CHANGE_ME_FEISHU_APPROVAL_ID",
  feishuChatId: "CHANGE_ME_FEISHU_CHAT_ID",
  feishuOpenId: "CHANGE_ME_FEISHU_OPEN_ID",
  docResource: "CHANGE_ME_FEISHU_DOC_URL_OR_TOKEN",
  docBlockId: "CHANGE_ME_FEISHU_DOC_BLOCK_ID",
  sheetResource: "CHANGE_ME_FEISHU_SHEET_URL_OR_TOKEN",
  sheetRange: "CHANGE_ME_FEISHU_SHEET_RANGE",
  sheetWriteRange: "CHANGE_ME_FEISHU_SHEET_WRITE_RANGE",
  baseResource: "CHANGE_ME_FEISHU_BASE_TABLE_URL_WITH_APP_TOKEN",
  baseRecordId: "CHANGE_ME_FEISHU_BASE_RECORD_ID",
} as const;
export interface FeishuReadinessReport {
  workspaceId: string;
  requiredReadiness: FeishuRequiredReadiness;
  integrationCount: number;
  readyForBotSmokeCount: number;
  readyForDataPlaneSmokeCount: number;
  readyForWorkerSmokeCount: number;
  strictSatisfied: boolean;
  integrations: FeishuIntegrationReadiness[];
}
export interface FeishuIntegrationReadiness {
  id: string;
  displayName: string;
  agentId?: string;
  status: string;
  transportMode: string;
  appConfigured: boolean;
  credentialsConfigured: boolean;
  healthStatus: string;
  channelBindings: BindingCountSummary;
  userBindings: BindingCountSummary;
  resourceBindings: BindingCountSummary & {
    doc: number;
    docWritable: number;
    sheet: number;
    sheetWritable: number;
    base: number;
    baseReady: number;
    baseWritable: number;
  };
  outboxFailures: number;
  pendingOutboxWithErrors: number;
  scopes: {
    configuredCount: number;
    missingForBotSmoke: string[];
    missingForDataPlaneSmoke: string[];
  };
  readyForBotSmoke: boolean;
  readyForDataPlaneSmoke: boolean;
  readyForWorkerSmoke: boolean;
  setupChecks: FeishuReadinessSetupCheck[];
  issues: string[];
}
export type FeishuReadinessSetupCheckStatus = "ready" | "missing" | "attention";
export interface FeishuReadinessSetupCheck {
  key:
    | "credentials"
    | "health"
    | "transport"
    | "chat_binding"
    | "user_binding"
    | "doc_binding"
    | "sheet_binding"
    | "base_binding"
    | "outbox";
  status: FeishuReadinessSetupCheckStatus;
  current: number | string;
  required?: number | string;
  issues: string[];
}
export interface FeishuSmokePlanReport {
  workspaceId: string;
  requiredReadiness: FeishuRequiredReadiness;
  integrationCount: number;
  strictSatisfied: boolean;
  selectedBotIntegrationId?: string;
  selectedDataPlaneIntegrationId?: string;
  selectedWorkerIntegrationId?: string;
  appSetup: FeishuOpenPlatformSetupSummary;
  runtimeSetup: FeishuRuntimeSetupSummary;
  smokeHarness: FeishuSmokeHarnessSummary;
  workerHarness: FeishuWorkerHarnessSummary;
  evidenceGates: FeishuSmokePlanEvidenceGate[];
  readinessSummary: {
    readyForBotSmokeCount: number;
    readyForDataPlaneSmokeCount: number;
    readyForWorkerSmokeCount: number;
  };
  blockers: FeishuSmokePlanBlocker[];
  steps: FeishuSmokePlanStep[];
}
export interface FeishuSmokePlanBlocker {
  issue: string;
  severity: "blocked" | "pending";
  affectedStepCount: number;
  blockedStepCount: number;
  pendingStepCount: number;
  firstStepId: string;
  firstStepTitle: string;
  nextAction: string;
}
export type FeishuSmokePlanEvidenceGateKey =
  | "bot_reply"
  | "native_agent_bot"
  | "guest_policy"
  | "worker_restart"
  | "worker_card_action"
  | "data_plane"
  | "failure_visibility"
  | "dofe-agent_local_evidence"
  | "openapi_artifact"
  | "bot_added_payload_artifact";
export interface FeishuSmokePlanEvidenceGate {
  key: FeishuSmokePlanEvidenceGateKey;
  required: string;
}
export interface FeishuOpenPlatformSetupSummary {
  callbackUrlStatus: "ready" | "app_url_missing" | "integration_missing";
  callbackUrl?: string;
  developerConsoleUrl: string;
  requiredCredentialFields: string[];
  requiredEvents: string[];
  botScopes: string[];
  dataPlaneScopes: string[];
  setupSteps: FeishuOpenPlatformSetupStep[];
}
export interface FeishuOpenPlatformSetupStep {
  id: string;
  consoleUrl: string;
  required: string[];
}
export interface FeishuRuntimeSetupSummary {
  credentialEncryption: FeishuCredentialEncryptionReadiness;
}
export interface FeishuCredentialEncryptionReadiness {
  status: "ready" | "missing" | "invalid";
  checkedEnvNames: string[];
  configuredEnvName?: string;
  issue?: string;
}
export interface FeishuSmokeHarnessSummary {
  envExamplePath: string;
  envFilePath: string;
  evidencePath: string;
  botAddedPayloadPath: string;
  botAddedPayloadEvidencePath: string;
  appUrl?: string;
  callbackUrl?: string;
  requiredLiveSteps: number;
  destructiveLiveChecks: number;
  destructiveLiveStepNames: string[];
  prepareEnvCommand: string;
  checkEnvCommand: string;
  strictLiveCommand: string;
  verifyEvidenceCommand: string;
  verifyBotAddedPayloadCommand: string;
}
export interface FeishuSmokeEnvTemplateReport {
  workspaceId: string;
  integrationCount: number;
  selectedIntegrationId?: string;
  appUrl?: string;
  envFilePath: string;
  entries: FeishuSmokeEnvTemplateEntry[];
  issues: string[];
}
export interface FeishuSmokeEnvTemplateEntry {
  key: string;
  value: string;
  secret: boolean;
  required: boolean;
  source: "integration" | "app-url" | "placeholder" | "env";
  note?: string;
}
export interface FeishuIntegrationCreateCliResult {
  ok: true;
  workspaceId: string;
  integrationId: string;
  displayName: string;
  status: string;
  transportMode: ExternalIntegrationTransportMode;
  appId: string;
  tenantKeyConfigured: boolean;
  credentialsStored: {
    appSecret: boolean;
    verificationToken: boolean;
    encryptKey: boolean;
  };
  requiredCredentialFields: string[];
  requiredEvents: string[];
  requiredScopeCount: number;
  openPlatformSetup: FeishuOpenPlatformSetupSummary;
  secretRedacted: true;
  auditRecorded: boolean;
  nextCommands: {
    healthCheck: string;
    smokePlan: string;
    smokeEnv: string;
    checkEnv: string;
    strictLiveSmoke: string;
    verifyOpenApiEvidence: string;
    verifyBotAddedPayload: string;
    finalEvidence: string;
    bindSecondAgentBot: string;
    bindChannel: string;
    bindUser: string;
    bindResourceDoc: string;
    bindResourceSheet: string;
    bindResourceBase: string;
  };
}
export interface FeishuCliErrorReport {
  ok: false;
  errorCode: string;
  errorMessage: string;
  nextStep?: string;
}
export interface FeishuIntegrationCreateCliInput {
  workspaceId: string;
  displayName?: string;
  transportMode?: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  tenantKey?: string;
  createdByUserId?: string;
  appUrl?: string;
}
export interface FeishuAgentBotCliInput {
  workspaceId: string;
  agentId?: string;
  integrationId?: string;
  displayName?: string;
  transportMode?: string;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  tenantKey?: string;
  channelAutoProvisioning?: FeishuAgentBotChannelAutoProvisioningInput;
  externalGuestPolicy?: FeishuAgentBotExternalGuestPolicyInput;
  actorUserId?: string;
}
export interface FeishuAgentBotCliResult {
  ok: true;
  kind: "agent_bot";
  operation: "created" | "rotated" | "disabled" | "policy_updated" | "policy_read";
  workspaceId: string;
  integrationId: string;
  agentId: string;
  displayName: string;
  status: string;
  transportMode: string;
  appId: string;
  tenantKeyConfigured: boolean;
  credentials: {
    hasAppSecret: boolean;
    hasVerificationToken: boolean;
    hasEncryptKey: boolean;
  };
  channelAutoProvisioning: FeishuChannelAutoProvisionPolicy;
  externalGuestPolicy: FeishuExternalParticipantPolicy;
  secretRedacted: true;
  nextCommands: FeishuAgentBotNextCommands;
}
export interface FeishuAgentBotNextCommands {
  healthCheck: string;
  botReadiness: string;
  dataPlaneReadiness: string;
  workerReadiness: string;
  autoProvisionPolicy: string;
  agentChannelAccessDisable: string;
  agentChannelAccessRestore: string;
  channelBindings: string;
  smokeEnv: string;
  checkEnv: string;
  strictLiveSmoke: string;
  verifyOpenApiEvidence: string;
  verifyBotAddedPayload: string;
  smokePlan: string;
  finalEvidence: string;
  bindSecondAgentBot: string;
}
export type FeishuAgentChannelMemberAccess = "enabled" | "disabled";
export interface FeishuAgentChannelAccessCliInput {
  workspaceId: string;
  agentId?: string;
  integrationId?: string;
  channelMemberAccess: FeishuAgentChannelMemberAccess;
  actorUserId?: string;
}
export interface FeishuAgentChannelAccessCliResult {
  ok: true;
  kind: "agent_channel_access";
  operation: "updated";
  workspaceId: string;
  agentId: string;
  integrationId?: string;
  channelMemberAccess: FeishuAgentChannelMemberAccess;
  totalActiveEmployees: number;
  nextCommands: {
    disableForSmoke: string;
    restoreAfterSmoke: string;
    smokePlan: string;
  };
}
export interface FeishuBindingCliResult {
  ok: true;
  kind: "channel" | "user" | "resource";
  workspaceId: string;
  integrationId: string;
  bindingId: string;
  status: string;
  externalIdRedacted: true;
  auditRecorded: boolean;
  channelName?: string;
  userId?: string;
  providerResourceType?: string;
  dofeAgentResourceType?: string;
  dofeAgentResourceId?: string;
}
export interface FeishuChannelBindingsCliReport {
  ok: true;
  workspaceId: string;
  integrationId?: string;
  integrationCount: number;
  bindingCount: number;
  activeBindingCount: number;
  externalIdsRedacted: true;
  integrations: FeishuChannelBindingsIntegrationSummary[];
  bindings: FeishuChannelBindingCliItem[];
}
export interface FeishuChannelBindingsIntegrationSummary {
  integrationId: string;
  displayName: string;
  agentId?: string;
  status: string;
  bindingCount: number;
  activeBindingCount: number;
}
export interface FeishuChannelBindingCliItem {
  bindingId: string;
  integrationId: string;
  integrationDisplayName: string;
  integrationAgentId?: string;
  channelName: string;
  externalChatReference: string;
  externalChatIdRedacted: true;
  externalChatType?: string;
  externalChatName?: string;
  status: string;
  syncMode: string;
  provisionSource?: string;
  reviewStatus?: string;
  agentId?: string;
  botBindingId?: string;
  linkedFromBindingId?: string;
  linkedFromAgentId?: string;
  linkedFromBotBindingId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface FeishuDataOperationCliResult {
  ok: boolean;
  workspaceId: string;
  integrationId: string;
  operationType: string;
  providerResourceType: string;
  externalIdRedacted: true;
  liveApiCalled: boolean;
  approvalRequired: boolean;
  approvalId?: string;
  approvalStatus?: string;
  runId?: string;
  runStatus?: string;
  resourceBindingId?: string;
  resultOk?: boolean;
  errorCode?: string;
  errorMessage?: string;
  payloadHash?: string;
  responseSummary?: Record<string, unknown>;
  previewSummary?: Record<string, unknown>;
}
export interface FeishuDataOperationApprovalReviewCliResult {
  ok: boolean;
  workspaceId: string;
  approvalId: string;
  decision?: "approved" | "rejected";
  approvalStatus?: string;
  externalIdRedacted: true;
  execution?: {
    runId: string;
    resultOk: boolean;
    runStatus: "succeeded" | "failed";
    errorCode?: string;
    errorMessage?: string;
    payloadHash?: string;
    responseSummary?: Record<string, unknown>;
    previewSummary?: Record<string, unknown>;
  };
  errorCode?: string;
  errorMessage?: string;
}
export interface FeishuWorkerHarnessSummary {
  integrationId?: string;
  systemdUnitPath: string;
  systemdEnvExamplePath: string;
  dockerComposePath: string;
  dockerEnvExamplePath: string;
  dryRunCommand: string;
  startCommand: string;
  systemdRestartCommand: string;
  dockerRestartCommand: string;
}
export interface FeishuSmokePlanStep {
  id: string;
  area: "setup" | "bot" | "data-plane" | "worker" | "failure";
  title: string;
  status: "done" | "pending" | "blocked";
  detail: string;
  command?: string;
  issues?: string[];
}
export interface FeishuHealthCheckCliReport {
  workspaceId: string;
  integrationId?: string;
  agentId?: string;
  agentOnly?: boolean;
  integrationCount: number;
  checkedCount: number;
  healthyCount: number;
  degradedCount: number;
  errorCount: number;
  strictSatisfied: boolean;
  persisted: boolean;
  results: FeishuHealthCheckCliItem[];
}
export interface FeishuHealthCheckCliItem {
  id: string;
  displayName: string;
  agentId?: string;
  status: ExternalIntegrationHealthStatus;
  previousHealthStatus?: string;
  checkedAt: string;
  botAppName?: string;
  scopeReadiness?: string;
  enabledScopeCount?: number;
  missingScopes?: string[];
  errorCode?: string;
  errorMessage?: string;
  persisted: boolean;
}
export interface FeishuEvidenceReport {
  workspaceId: string;
  integrationId?: string;
  requiredEvidence: FeishuEvidenceRequirement;
  integrationCount: number;
  strictSatisfied: boolean;
  issues: string[];
  remediationSteps: FeishuEvidenceRemediationStep[];
  openApiEvidence?: FeishuOpenApiSmokeEvidenceVerification;
  botAddedPayloadEvidence?: FeishuBotAddedPayloadEvidenceVerification;
  summary: {
    botSatisfiedCount: number;
    nativeExperienceSatisfiedCount: number;
    guestPolicySatisfiedCount: number;
    dataPlaneSatisfiedCount: number;
    workerSatisfiedCount: number;
    failureVisibleCount: number;
    workspaceBotSatisfied: boolean;
    workspaceNativeExperienceSatisfied: boolean;
    workspaceGuestPolicySatisfied: boolean;
    workspaceDataPlaneSatisfied: boolean;
    workspaceWorkerSatisfied: boolean;
    workspaceFailureVisible: boolean;
    workspaceAllSatisfied: boolean;
    scopedAllSatisfied: boolean;
    localEvidenceFreshRows: number;
    localEvidenceStaleRows: number;
    workspaceLocalEvidenceFreshRows: number;
    workspaceLocalEvidenceStaleRows: number;
    localEvidenceMaxAgeHours: number;
  };
  integrations: FeishuIntegrationEvidence[];
}
export interface FeishuIntegrationEvidence {
  id: string;
  displayName: string;
  agentId?: string;
  status: string;
  transportMode: string;
  localEvidenceFreshness: FeishuLocalEvidenceFreshnessSummary;
  bot: {
    processedInboundEvents: number;
    inboundMessageMappings: number;
    sentOutboxItems: number;
    outboundMessageMappings: number;
    correlatedReplyMappings: number;
    satisfied: boolean;
  };
  nativeExperience: {
    agentBotRouteEvidence: number;
    nativeBotReplyEvidence: number;
    boundUserMentionEvidence: number;
    externalGuestMentionEvidence: number;
    agentChannelPolicyDeniedEvidence: number;
    botSenderLoopGuardEvidence: number;
    autoProvisionedChannelBindings: number;
    botAddedAutoProvisionedChannelBindings: number;
    firstMessageAutoProvisionedChannelBindings: number;
    reusedProviderChannelBindings: number;
    threadTaskBindings: number;
    threadContinuationEvidence: number;
    threadCollaborationEvidence: number;
    threadCollaborationCardEvidence: number;
    satisfied: boolean;
  };
  guestPolicy: {
    externalGuestAllowedEvidence: number;
    externalGuestReplyAllEvidence: number;
    externalGuestRequireIdentityEvidence: number;
    externalGuestIdentityBindingNoticeEvidence: number;
    externalGuestIgnoreEvidence: number;
    externalGuestMentionRequiredEvidence: number;
    satisfied: boolean;
  };
  dataPlane: {
    docReadSucceeded: number;
    agentDocReadSucceeded: number;
    docWriteSucceeded: number;
    docApprovedWritesSucceeded: number;
    sheetReadSucceeded: number;
    sheetWriteSucceeded: number;
    sheetApprovedWritesSucceeded: number;
    sheetApprovedWriteSyncSucceeded: number;
    baseReadSucceeded: number;
    baseMutateSucceeded: number;
    baseApprovedMutationsSucceeded: number;
    baseApprovedMutationSyncSucceeded: number;
    userActorEvidence: number;
    externalGuestActorEvidence: number;
    externalGuestReadSucceeded: number;
    externalGuestWriteDeniedEvidence: number;
    satisfied: boolean;
  };
  worker: {
    correlatedReplyMappings: number;
    requiredCorrelatedReplies: number;
    restartRecoverySatisfied: boolean;
    processedApprovalCardActions: number;
    approvalCardActionSatisfied: boolean;
    satisfied: boolean;
  };
  failureVisibility: {
    healthStatus: ExternalIntegrationHealthStatus;
    healthFailureVisible: boolean;
    providerFailureVisible: boolean;
    agentBotFailureEvidence: number;
    failedEvents: number;
    failedOutboxItems: number;
    failedDataOperations: number;
    satisfied: boolean;
  };
  issues: string[];
  remediationSteps: FeishuEvidenceRemediationStep[];
}
export interface FeishuLocalEvidenceFreshnessSummary {
  totalRows: number;
  freshRows: number;
  staleRows: number;
  maxAgeHours: number;
}
export interface FeishuOpenApiSmokeEvidenceVerification {
  evidencePath?: string;
  present: boolean;
  valid: boolean;
  issues: string[];
  remediationSteps: FeishuEvidenceRemediationStep[];
  summary?: {
    live: boolean;
    strictLive: boolean;
    strictLiveSatisfied: boolean;
    liveChecks: number;
    livePassed: number;
    liveSkipped: number;
    liveFailed: number;
    destructiveLiveChecks: number;
    requiredLiveSteps: number;
    generatedAtPresent: boolean;
    generatedAtFresh: boolean;
    appIdentityPresent: boolean;
    appIdHashPresent: boolean;
    appIdentityMatched: boolean;
    matchedIntegrationId?: string;
    tenantKeyHashPresent: boolean;
    tenantKeyMatched: boolean;
    todo120NativeSmokeReady: boolean;
    todo120NativeSmokeRequiredForCommand: boolean;
    todo120NativeSmokeRequired: number;
    todo120NativeSmokeConfigured: number;
    todo120NativeSmokeSecondAgentAppIdHashPresent: boolean;
  };
}
export interface FeishuBotAddedPayloadEvidenceVerification {
  evidencePath?: string;
  present: boolean;
  valid: boolean;
  issues: string[];
  remediationSteps: FeishuEvidenceRemediationStep[];
  summary?: {
    eventType: string;
    botAddedEvent: boolean;
    appIdPresent: boolean;
    appIdHashPresent: boolean;
    appIdentityMatched: boolean;
    matchedIntegrationId?: string;
    tenantKeyPresent: boolean;
    tenantKeyHashPresent: boolean;
    tenantKeyMatched: boolean;
    chatDescriptorPresent: boolean;
    chatIdSource?: string;
    chatReference?: string;
    chatIdRedacted: boolean;
    chatType?: string;
    chatNamePresent: boolean;
    externalEventReference?: string;
    externalEventIdRedacted: boolean;
    eventCreateTimePresent: boolean;
    eventCreateTimeFresh: boolean;
    payloadHashPresent: boolean;
    rawPayloadStored: boolean;
    generatedAtPresent: boolean;
    generatedAtFresh: boolean;
  };
}
export interface FeishuEvidenceRemediationStep {
  stepId: string;
  title: string;
  detail: string;
  issues: string[];
  command?: string;
}
export interface BindingCountSummary {
  active: number;
  total: number;
}
export type FeishuRequiredReadiness = "bot" | "data-plane" | "worker";
export type FeishuEvidenceRequirement = "bot" | "native" | "guest-policy" | "data-plane" | "worker" | "failure" | "all";
export interface BuildFeishuReadinessReportInput {
  workspaceId: string;
  integrationId?: string;
  agentId?: string;
  agentOnly?: boolean;
  requiredReadiness?: FeishuRequiredReadiness;
  integrations?: ExternalIntegrationRecord[];
  channelBindingsByIntegrationId?: Record<string, ExternalChannelBindingRecord[]>;
  userBindingsByIntegrationId?: Record<string, ExternalUserBindingRecord[]>;
  resourceBindingsByIntegrationId?: Record<string, ExternalResourceBindingRecord[]>;
  failedOutboxByIntegrationId?: Record<string, ExternalMessageOutboxRecord[]>;
  pendingOutboxByIntegrationId?: Record<string, ExternalMessageOutboxRecord[]>;
}
export interface BuildFeishuSmokePlanReportInput extends BuildFeishuReadinessReportInput {
  appUrl?: string;
  runtimeEnv?: Record<string, string | undefined>;
}
export interface BuildFeishuEvidenceReportInput {
  workspaceId: string;
  integrationId?: string;
  requiredEvidence?: FeishuEvidenceRequirement;
  openApiEvidencePath?: string;
  openApiEvidence?: unknown;
  botAddedPayloadEvidencePath?: string;
  botAddedPayloadEvidence?: unknown;
  integrations?: ExternalIntegrationRecord[];
  eventsByIntegrationId?: Record<string, ExternalIntegrationEventRecord[]>;
  messageMappingsByIntegrationId?: Record<string, ExternalMessageMappingRecord[]>;
  outboxByIntegrationId?: Record<string, ExternalMessageOutboxRecord[]>;
  channelBindingsByIntegrationId?: Record<string, ExternalChannelBindingRecord[]>;
  threadBindingsByIntegrationId?: Record<string, ExternalThreadBindingRecord[]>;
  dataOperationsByIntegrationId?: Record<string, ExternalDataOperationRunRecord[]>;
}
export interface FeishuIntegrationEvidenceSource {
  workspaceId: string;
  integration: ExternalIntegrationRecord;
  events: ExternalIntegrationEventRecord[];
  messageMappings: ExternalMessageMappingRecord[];
  outbox: ExternalMessageOutboxRecord[];
  channelBindings: ExternalChannelBindingRecord[];
  threadBindings: ExternalThreadBindingRecord[];
  dataOperations: ExternalDataOperationRunRecord[];
  localEvidenceFreshness?: FeishuLocalEvidenceFreshnessSummary;
}
export interface FeishuExpectedCallbackRouteProof {
  integrationId: string;
  callbackRoute: string;
  callbackRouteFingerprint: string;
}
export interface FeishuExpectedBotAddedPayloadIdentityProof {
  integrationId: string;
  appIdHash: string;
  tenantKeyHash?: string;
}
export interface FeishuExpectedBotAddedPayloadChatReferenceProof {
  integrationId: string;
  chatReference: string;
}
export interface FeishuExpectedTodo120NativeSecondAgentAppProof {
  anchorIntegrationId: string;
  secondIntegrationId: string;
  appIdHash: string;
}
export interface BuildFeishuSmokeEnvTemplateReportInput {
  workspaceId: string;
  integrationId?: string;
  appUrl?: string;
  integrations?: ExternalIntegrationRecord[];
}
export type FeishuApiUploadRequest = Parameters<NonNullable<FeishuApiClient["upload"]>>[0];
