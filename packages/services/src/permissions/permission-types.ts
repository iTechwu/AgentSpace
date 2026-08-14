// 权限中心共享类型（含内部构建上下文 PermissionBuildContext）。
import {
  listAgentAccessRequestsSync,
  listAgentForkInvitationsSync,
  listChannelAccessRequestsSync,
  listChannelInvitationsSync,
  listDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync,
  listWorkspaceChannelParticipantsSync,
} from "@dofe-agent/db";
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ActiveEmployee,
  ChannelRecord,
  WorkspaceSkill,
} from "@dofe-agent/domain/workspace";
import {
  ensureWorkspaceStateSync,
} from "../shared/state-io.ts";

export type PermissionSubjectType =
  | "human"
  | "agent"
  | "daemon_token"
  | "external_guest"
  | "system";

export type PermissionResourceType =
  | "workspace"
  | "channel"
  | "channel_invitation"
  | "channel_access_request"
  | "agent"
  | "agent_fork_invitation"
  | "agent_access_request"
  | "runtime"
  | "daemon"
  | "file"
  | "document"
  | "external_document"
  | "skill"
  | "knowledge_page"
  | "external_identity_policy";

export type PermissionSource =
  | "workspace_role"
  | "direct_grant"
  | "channel_participant"
  | "document_collaborator"
  | "document_agent_access"
  | "document_permission_request"
  | "runtime_grant"
  | "agent_owner"
  | "agent_fork"
  | "agent_access_request"
  | "agent_channel_member_access"
  | "knowledge_assignment"
  | "skill_assignment"
  | "external_document_permission"
  | "external_guest_policy"
  | "derived";

export type PermissionNodeStatus = "active" | "pending" | "revoked" | "error" | "inherited";

export type PermissionBindingStatus = "active" | "pending" | "revoked" | "inherited" | "external";

export type PermissionDiagnosticSeverity = "info" | "warning" | "critical";

export type PermissionMetadataValue = string | number | boolean | null | string[];

export interface PermissionBinding {
  subjectType: PermissionSubjectType;
  subjectId: string;
  subjectLabel: string;
  permission: string;
  source: PermissionSource;
  status: PermissionBindingStatus;
  editable: boolean;
  revokeAction?: string;
  updateAction?: string;
  inheritedFromNodeId?: string;
  lastChangedAt?: string;
  metadata?: Record<string, PermissionMetadataValue | undefined>;
}

export interface PermissionDiagnostic {
  id: string;
  severity: PermissionDiagnosticSeverity;
  title: string;
  description: string;
  source: PermissionSource | "system";
  resourceNodeId?: string;
  subjectType?: PermissionSubjectType;
  subjectId?: string;
  lastChangedAt?: string;
}

export interface PermissionTreeNode {
  id: string;
  parentId?: string;
  resourceType: PermissionResourceType;
  label: string;
  status?: PermissionNodeStatus;
  source?: PermissionSource;
  bindings: PermissionBinding[];
  children?: PermissionTreeNode[];
  diagnostics?: PermissionDiagnostic[];
  metadata?: Record<string, PermissionMetadataValue | undefined>;
}

export interface PermissionActorSummary {
  subjectType: PermissionSubjectType;
  subjectId: string;
  subjectLabel: string;
  status: "active" | "pending" | "revoked" | "external";
  permissions: Array<{
    nodeId: string;
    resourceType: PermissionResourceType;
    resourceLabel: string;
    permission: string;
    source: PermissionSource;
    status: PermissionBindingStatus;
    editable: boolean;
    inheritedFromNodeId?: string;
    lastChangedAt?: string;
  }>;
  diagnostics: PermissionDiagnostic[];
}

export interface PermissionCatalogMember {
  userId: string;
  displayName: string;
  primaryEmail?: string;
  role: WorkspaceRole;
}

export interface PermissionCatalogAgent {
  employeeName: string;
  label: string;
}

export interface PermissionCatalogSkill {
  id: string;
  name: string;
}

export interface PermissionCatalogKnowledgePage {
  id: string;
  title: string;
  assignmentMode: "all_agents" | "selected_agents";
}

export interface PermissionCenterData {
  tree: PermissionTreeNode[];
  actors: PermissionActorSummary[];
  diagnostics: PermissionDiagnostic[];
  catalog: {
    members: PermissionCatalogMember[];
    agents: PermissionCatalogAgent[];
    skills: PermissionCatalogSkill[];
    knowledgePages: PermissionCatalogKnowledgePage[];
  };
}

export interface PermissionCenterActorInput {
  userId: string;
  displayName: string;
  role: WorkspaceRole;
}

export interface PermissionBuildContext {
  workspaceId: string;
  actor: PermissionCenterActorInput;
  isManager: boolean;
  workspaceNodeId: string;
  state: ReturnType<typeof ensureWorkspaceStateSync>;
  visibleChannels: ChannelRecord[];
  visibleEmployees: ActiveEmployee[];
  visibleRuntimeIds: Set<string>;
  channelParticipantsByName: Map<string, ReturnType<typeof listWorkspaceChannelParticipantsSync>>;
  channelAccessRequestsByName: Map<string, ReturnType<typeof listChannelAccessRequestsSync>>;
  channelInvitationsByName: Map<string, ReturnType<typeof listChannelInvitationsSync>>;
  documentAgentAccessByDocumentId: Map<string, ReturnType<typeof listDocumentAgentAccessSync>>;
  documentAgentAccessBySubjectId: Map<string, ReturnType<typeof listDocumentAgentAccessSync>>;
  documentPermissionRequests: ReturnType<typeof listDocumentPermissionRequestsSync>;
  documentPermissionRequestsByDocumentId: Map<string, ReturnType<typeof listDocumentPermissionRequestsSync>>;
  documentPermissionRequestsByAgentName: Map<string, ReturnType<typeof listDocumentPermissionRequestsSync>>;
  agentForkInvitationsBySourceName: Map<string, ReturnType<typeof listAgentForkInvitationsSync>>;
  agentAccessRequestsBySourceName: Map<string, ReturnType<typeof listAgentAccessRequestsSync>>;
  agentAccessRequests: ReturnType<typeof listAgentAccessRequestsSync>;
  memberByUserId: Map<string, PermissionCatalogMember>;
  memberByDisplayName: Map<string, PermissionCatalogMember>;
  runtimeLabelById: Map<string, string>;
  skillById: Map<string, WorkspaceSkill>;
}
