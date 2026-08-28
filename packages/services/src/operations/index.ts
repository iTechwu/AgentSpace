// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/operations` 子路径与根 re-export 使用。

export {
  decideAgentActionPolicySync,
  type AgentActionPolicyActor,
  type AgentActionPolicyDecision,
  type AgentActionPolicyDecisionValue,
  type AgentActionPolicyInput,
  type AgentActionReviewerRole,
  type AgentActionRiskLevel,
  type AgentActionType,
} from "../policies/agent-actions.ts";

export {
  decideWorkspaceDataPolicyForExternalMessageSync,
  type WorkspaceDataPolicyAllowedUses,
  type WorkspaceDataPolicyClassification,
  type WorkspaceDataPolicyDecision,
  type WorkspaceDataPolicyDecisionValue,
  type WorkspaceDataPolicyInput,
} from "../policies/workspace-data.ts";

export {
  acceptAgentForkInvitationForActorSync,
  createAgentForkInvitationForActorSync,
  listAgentForkInvitationsForActorSync,
  listAgentForkInvitationsForSourceAgentSync,
  revokeAgentForkInvitationForActorSync,
  type AgentForkInvitationRecord,
  type AgentForkOptions,
  type AgentForkSnapshot,
} from "../agent-forks/agent-forks.ts";

export {
  approveAgentAccessRequestForActorSync,
  cancelAgentAccessRequestForActorSync,
  canDecideAgentAccessRequest,
  createAgentAccessRequestForActorSync,
  listAgentAccessRequestsForActorSync,
  rejectAgentAccessRequestForActorSync,
  type AgentAccessRequestRecord,
  type AgentAccessRequestStatus,
  type AgentAccessRequestType,
} from "../agent-access-requests/agent-access-requests.ts";

export {
  resolveSystemAgentTemplateForWorkspaceSync,
  type ResolvedAgentTemplateForWorkspace,
} from "../agent-templates/agent-templates.ts";

export {
  listAutomationRulesSync,
  readAutomationRuleSync,
  createAutomationRuleSync,
  updateAutomationRuleSync,
  toggleAutomationRuleSync,
  deleteAutomationRuleSync,
} from "../automations/automations.ts";

export {
  AUTO_CONTINUATION_REPLY,
  continueAutoContinuationAfterTaskSync,
  createAutoContinuationState,
  parseAutoContinuationDirective,
  stopAutoContinuationSync,
  type AutoContinuationDirective,
  type AutoContinuationDispatchResult,
  type StopAutoContinuationResult,
} from "../automations/auto-continuation.ts";

export {
  listScheduledTasksSync,
  readScheduledTaskSync,
  createScheduledTaskSync,
  updateScheduledTaskSync,
  toggleScheduledTaskSync,
  deleteScheduledTaskSync,
} from "../schedules/schedules.ts";

export {
  getWorkspacePermissionCenter,
  getWorkspacePermissionCenterSync,
  getWorkspacePermissionTreeSync,
  getWorkspaceActorPermissionSummarySync,
  getPermissionDiagnosticsSync,
  type PermissionActorSummary,
  type PermissionBinding,
  type PermissionCatalogAgent,
  type PermissionCatalogKnowledgePage,
  type PermissionCatalogMember,
  type PermissionCatalogSkill,
  type PermissionCenterActorInput,
  type PermissionCenterData,
  type PermissionDiagnostic,
  type PermissionResourceType,
  type PermissionSource,
  type PermissionSubjectType,
  type PermissionTreeNode,
} from "../permissions/permissions.ts";

export {
  AgentDocumentPermissionError,
  approveDocumentPermissionRequestSync,
  assertAgentDocumentActionAllowedSync,
  cancelDocumentPermissionRequestSync,
  createDocumentPermissionRequestSync,
  grantDocumentAgentAccessAsync,
  grantDocumentAgentAccessSync,
  listDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync,
  listPendingDocumentPermissionRequestsSync,
  rejectDocumentPermissionRequestSync,
  resolveAgentDocumentContextSync,
  resolveAgentDocumentRejectionContextSync,
  revokeDocumentAgentAccessAsync,
  revokeDocumentAgentAccessSync,
  type AgentDocumentContext,
  type DocumentAgentAccessRecord,
  type DocumentPermissionRequestExternalProvider,
  type DocumentPermissionRequestRecord,
} from "../document-permissions/document-permissions.ts";
