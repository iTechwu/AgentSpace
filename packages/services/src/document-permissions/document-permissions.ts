import {
  approveDocumentPermissionRequestSync as approveStoredDocumentPermissionRequestSync,
  cancelDocumentPermissionRequestSync as cancelStoredDocumentPermissionRequestSync,
  createDocumentPermissionRequestSync as createStoredDocumentPermissionRequestSync,
  grantDocumentAgentAccessSync as grantStoredDocumentAgentAccessSync,
  linkDocumentPermissionRequestDocumentSync,
  listDocumentAgentAccessSync as listStoredDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync as listStoredDocumentPermissionRequestsSync,
  listGoogleOAuthCredentialsSync,
  listWorkspaceMembershipsSync,
  readDocumentPermissionRequestSync,
  readWorkspaceMembershipSync,
  readUserSync,
  rejectDocumentPermissionRequestSync as rejectStoredDocumentPermissionRequestSync,
  revokeDocumentAgentAccessSync as revokeStoredDocumentAgentAccessSync,
  type DocumentAgentAccessRecord,
  type DocumentPermissionRequestExternalProvider,
  type DocumentPermissionRequestRecord,
} from "@dofe-agent/db";
import {
  allowsDocumentAction,
  getAllowedDocumentActions,
  type AgentAssignableDocumentAccessRole,
  type DocumentAccessRole,
  type DocumentAction,
} from "@dofe-agent/domain";
import type { ChannelDocument } from "@dofe-agent/domain/workspace";
import { resolveChannelHumanMemberNames } from "../channels/channels.ts";
import {
  createExternalGoogleDocChannelDocumentSync,
  createExternalGoogleSheetChannelDocumentSync,
  readChannelDocumentSync,
} from "../documents/sync.ts";
import { recordTaskExecutionEventSync } from "../task-execution-events.ts";
import { readWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { createNotificationsSync, createNotificationSync, postNotificationChannelMessageSync } from "../notifications/notifications.ts";

export type {
  DocumentAgentAccessRecord,
  DocumentPermissionRequestExternalProvider,
  DocumentPermissionRequestRecord,
};

export interface AgentDocumentContext {
  document: ChannelDocument;
  role: DocumentAccessRole;
  source: "channel_context" | "explicit_grant" | "forward_grant";
  allowedActions: DocumentAction[];
}

export class AgentDocumentPermissionError extends Error {
  readonly code:
    | "provider.document_read_denied"
    | "provider.document_edit_denied"
    | "provider.document_forward_denied"
    | "provider.document_external_auth_unavailable";
  readonly documentId?: string;
  readonly agentName: string;
  readonly action: DocumentAction;

  constructor(input: {
    code: AgentDocumentPermissionError["code"];
    message: string;
    agentName: string;
    action: DocumentAction;
    documentId?: string;
  }) {
    super(input.message);
    this.name = "AgentDocumentPermissionError";
    this.code = input.code;
    this.agentName = input.agentName;
    this.action = input.action;
    this.documentId = input.documentId;
  }
}

export function grantDocumentAgentAccessSync(input: {
  workspaceId: string;
  documentId: string;
  agentName: string;
  role: AgentAssignableDocumentAccessRole;
  grantedByUserId: string;
}): DocumentAgentAccessRecord {
  assertAgentAssignableRole(input.role);
  assertDocumentExists(input.workspaceId, input.documentId);
  const grant = grantStoredDocumentAgentAccessSync({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    subjectId: input.agentName,
    role: input.role,
    grantedByUserId: input.grantedByUserId,
  });
  const { document } = readChannelDocumentSync(input.documentId, input.workspaceId);
  const agentOwner = resolveAgentOwnerUser(input.workspaceId, input.agentName);
  const granter = readUserSync(input.grantedByUserId);
  createNotificationsSync([
    {
      workspaceId: input.workspaceId,
      recipientType: "agent",
      recipientId: input.agentName,
      actorType: "human",
      actorId: input.grantedByUserId,
      type: "document.agent_access_granted",
      resourceType: "document",
      resourceId: document.id,
      channelName: document.channelName,
      title: "Document access granted",
      body: `${input.agentName} can now use ${input.role} access on "${document.title}".`,
      actionHref: `/im?focus=${encodeURIComponent(`channel:${document.channelName}`)}`,
      severity: "success",
      dedupeKey: `document.agent_access_granted:${input.workspaceId}:${document.id}:${input.agentName}:${input.role}`,
      metadata: {
        documentTitle: document.title,
        agentName: input.agentName,
        role: input.role,
        grantedByUserId: input.grantedByUserId,
      },
    },
    ...(agentOwner
      ? [{
          workspaceId: input.workspaceId,
          recipientType: "human" as const,
          recipientId: agentOwner.id,
          actorType: "human" as const,
          actorId: input.grantedByUserId,
          type: "document.agent_access_granted.owner",
          resourceType: "document" as const,
          resourceId: document.id,
          channelName: document.channelName,
          title: "Agent document access granted",
          body: `${granter?.displayName ?? "A workspace member"} granted ${input.agentName} ${input.role} access on "${document.title}".`,
          actionHref: `/im?focus=${encodeURIComponent(`channel:${document.channelName}`)}`,
          severity: "success" as const,
          dedupeKey: `document.agent_access_granted.owner:${input.workspaceId}:${document.id}:${input.agentName}:${input.role}:${agentOwner.id}`,
          metadata: {
            documentTitle: document.title,
            agentName: input.agentName,
            role: input.role,
            grantedByUserId: input.grantedByUserId,
          },
        }]
      : []),
  ]);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Document agent access granted",
    note: `${input.agentName} was granted ${input.role} on "${document.title}".`,
    code: "document_agent_access.granted",
    data: {
      documentId: document.id,
      documentTitle: document.title,
      agentName: input.agentName,
      role: input.role,
      grantedByUserId: input.grantedByUserId,
    },
  });
  return grant;
}

export function revokeDocumentAgentAccessSync(input: {
  workspaceId: string;
  documentId: string;
  agentName: string;
}): DocumentAgentAccessRecord | null {
  const revoked = revokeStoredDocumentAgentAccessSync({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    subjectId: input.agentName,
  });
  if (revoked) {
    const document = tryReadChannelDocument(input.workspaceId, input.documentId);
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Document agent access revoked",
      note: `${input.agentName} access was revoked on "${document?.title ?? input.documentId}".`,
      code: "document_agent_access.revoked",
      data: {
        documentId: input.documentId,
        agentName: input.agentName,
      },
    });
  }
  return revoked;
}

export function listDocumentAgentAccessSync(input: {
  workspaceId: string;
  documentId?: string;
  agentName?: string;
  includeRevoked?: boolean;
}): DocumentAgentAccessRecord[] {
  return listStoredDocumentAgentAccessSync({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    subjectId: input.agentName,
    includeRevoked: input.includeRevoked,
  });
}

export function resolveAgentDocumentContextSync(input: {
  workspaceId: string;
  agentName: string;
  channelName?: string;
  documentIds?: string[];
}): AgentDocumentContext[] {
  const state = readWorkspaceStateSync(input.workspaceId);
  const requestedDocumentIds = new Set((input.documentIds ?? []).map((id) => id.trim()).filter(Boolean));
  const explicitGrants = listStoredDocumentAgentAccessSync({
    workspaceId: input.workspaceId,
    subjectId: input.agentName,
  });
  const explicitByDocumentId = new Map(explicitGrants.map((grant) => [grant.documentId, grant]));
  const result = new Map<string, AgentDocumentContext>();

  for (const document of state.channelDocuments.filter((item) => item.status === "active")) {
    if (requestedDocumentIds.size > 0 && !requestedDocumentIds.has(document.id)) {
      continue;
    }

    const channelRole =
      input.channelName && sameValue(document.channelName, input.channelName) && agentBelongsToChannel(state, input.agentName, input.channelName)
        ? resolveChannelContextRole(state, document, input.agentName)
        : undefined;
    const explicitGrant = explicitByDocumentId.get(document.id);
    const explicitRole = resolveExplicitRoleForContext(explicitGrant?.role, document, input.channelName);
    const role = maxDocumentRole(channelRole, explicitRole);
    if (!role) {
      continue;
    }

    const source = explicitRole && allowsDocumentAction(explicitRole, "forward") && (!input.channelName || !sameValue(document.channelName, input.channelName))
      ? "forward_grant"
      : explicitRole && (!channelRole || roleRank(explicitRole) <= roleRank(channelRole))
        ? "explicit_grant"
        : "channel_context";
    result.set(document.id, {
      document,
      role,
      source,
      allowedActions: getAllowedDocumentActions(role),
    });
  }

  return [...result.values()].sort((left, right) =>
    left.document.title.localeCompare(right.document.title, "zh-CN", { sensitivity: "base" }),
  );
}

export function assertAgentDocumentActionAllowedSync(input: {
  workspaceId: string;
  agentName: string;
  action: DocumentAction;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  channelName?: string;
}): AgentDocumentContext {
  const context = resolveAgentDocumentForAction(input);
  if (context && allowsDocumentAction(context.role, input.action)) {
    return context;
  }

  const code = input.action === "view"
    ? "provider.document_read_denied"
    : input.action === "edit"
      ? "provider.document_edit_denied"
      : input.action === "forward"
        ? "provider.document_forward_denied"
        : "provider.document_edit_denied";
  throw new AgentDocumentPermissionError({
    code,
    agentName: input.agentName,
    action: input.action,
    documentId: input.documentId,
    message: `${code}: Agent "${input.agentName}" cannot ${input.action} document "${input.documentId ?? input.externalFileId ?? "unknown"}".`,
  });
}

export function createDocumentPermissionRequestSync(input: {
  workspaceId: string;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  externalUrl?: string;
  requestedRole: AgentAssignableDocumentAccessRole;
  requestedByAgentName: string;
  requestedForChannelName?: string;
  triggeredByUserId?: string;
  reason: string;
  sourceTaskId?: string;
}): DocumentPermissionRequestRecord {
  assertAgentAssignableRole(input.requestedRole);
  const request = createStoredDocumentPermissionRequestSync(input);
  const document = request.documentId ? tryReadChannelDocument(input.workspaceId, request.documentId) : undefined;
  const targetChannelName = request.requestedForChannelName ?? document?.channelName;

  if (targetChannelName) {
    postSystemMessageSafely({
      workspaceId: input.workspaceId,
      channelName: targetChannelName,
      summary: `${request.requestedByAgentName} requested ${request.requestedRole} access${document ? ` to "${document.title}"` : " to an external document"}.`,
      code: "document_permission.requested",
      data: {
        requestId: request.id,
        documentId: request.documentId,
        requestedRole: request.requestedRole,
        requestedByAgentName: request.requestedByAgentName,
      },
    });
  }
  const approvers = resolveDocumentPermissionApproverRecipients(input.workspaceId, request, document);
  createNotificationsSync(approvers.map((recipient) => ({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: recipient.userId,
    actorType: "agent",
    actorId: request.requestedByAgentName,
    type: "document_permission.requested",
    resourceType: "approval",
    resourceId: request.id,
    channelName: targetChannelName,
    title: "Document permission requested",
    body: `${request.requestedByAgentName} requested ${request.requestedRole} access${document ? ` to "${document.title}"` : " to an external document"}.`,
    actionHref: "/approvals",
    severity: "warning",
    dedupeKey: `document_permission.requested:${input.workspaceId}:${request.id}:${recipient.userId}`,
    metadata: {
      requestId: request.id,
      documentId: request.documentId,
      externalFileId: request.externalFileId,
      requestedRole: request.requestedRole,
      requestedByAgentName: request.requestedByAgentName,
      requestedForChannelName: request.requestedForChannelName,
    },
  })));
  if (input.sourceTaskId) {
    recordTaskExecutionEventSync({
      workspaceId: input.workspaceId,
      taskId: input.sourceTaskId,
      channelName: targetChannelName,
      agentId: request.requestedByAgentName,
      type: "approval_requested",
      title: "Document permission requested",
      summary: `${request.requestedByAgentName} requested ${request.requestedRole} document access.`,
      severity: "warning",
      status: "pending",
      data: {
        requestId: request.id,
        documentId: request.documentId,
        externalFileId: request.externalFileId,
        requestedRole: request.requestedRole,
      },
    });
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Document permission requested",
    note: `${request.requestedByAgentName} requested ${request.requestedRole} document access.`,
    code: "document_permission.requested",
    data: {
      requestId: request.id,
      documentId: request.documentId,
      externalFileId: request.externalFileId,
      requestedRole: request.requestedRole,
      requestedByAgentName: request.requestedByAgentName,
      requestedForChannelName: request.requestedForChannelName,
    },
  });
  return request;
}

export function approveDocumentPermissionRequestSync(input: {
  workspaceId: string;
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  const before = readDocumentPermissionRequestSync(input.requestId);
  if (!before || before.workspaceId !== input.workspaceId) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  assertCanDecideDocumentPermissionRequest({
    workspaceId: input.workspaceId,
    request: before,
    decidedByUserId: input.decidedByUserId,
  });
  const linked = ensurePermissionRequestHasDocument(input.workspaceId, before, input.decidedByUserId);
  const request = approveStoredDocumentPermissionRequestSync({
    requestId: linked.id,
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote,
  });
  const document = request.documentId ? tryReadChannelDocument(input.workspaceId, request.documentId) : undefined;
  postRequestDecisionMessage(input.workspaceId, request, document, "approved");
  notifyDocumentPermissionDecision(input.workspaceId, request, document, "approved", input.decidedByUserId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Document permission approved",
    note: `${request.requestedByAgentName} was granted ${request.requestedRole}${document ? ` on "${document.title}"` : ""}.`,
    code: "document_permission.approved",
    data: {
      requestId: request.id,
      documentId: request.documentId,
      requestedByAgentName: request.requestedByAgentName,
      requestedRole: request.requestedRole,
      decidedByUserId: input.decidedByUserId,
    },
  });
  return request;
}

export function rejectDocumentPermissionRequestSync(input: {
  workspaceId: string;
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  const before = readDocumentPermissionRequestSync(input.requestId);
  if (!before || before.workspaceId !== input.workspaceId) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  assertCanDecideDocumentPermissionRequest({
    workspaceId: input.workspaceId,
    request: before,
    decidedByUserId: input.decidedByUserId,
  });
  const request = rejectStoredDocumentPermissionRequestSync({
    requestId: input.requestId,
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote,
  });
  const document = request.documentId ? tryReadChannelDocument(input.workspaceId, request.documentId) : undefined;
  postRequestDecisionMessage(input.workspaceId, request, document, "rejected");
  notifyDocumentPermissionDecision(input.workspaceId, request, document, "rejected", input.decidedByUserId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Document permission rejected",
    note: `${request.requestedByAgentName} ${request.requestedRole} document access was rejected.`,
    code: "document_permission.rejected",
    data: {
      requestId: request.id,
      documentId: request.documentId,
      requestedByAgentName: request.requestedByAgentName,
      requestedRole: request.requestedRole,
      decidedByUserId: input.decidedByUserId,
    },
  });
  return request;
}

export function cancelDocumentPermissionRequestSync(input: {
  workspaceId: string;
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  const before = readDocumentPermissionRequestSync(input.requestId);
  if (!before || before.workspaceId !== input.workspaceId) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  return cancelStoredDocumentPermissionRequestSync({
    requestId: input.requestId,
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote,
  });
}

export function listPendingDocumentPermissionRequestsSync(input: {
  workspaceId: string;
  requestedByAgentName?: string;
  documentId?: string;
}): DocumentPermissionRequestRecord[] {
  return listStoredDocumentPermissionRequestsSync({
    workspaceId: input.workspaceId,
    status: "pending",
    requestedByAgentName: input.requestedByAgentName,
    documentId: input.documentId,
  });
}

export function listDocumentPermissionRequestsSync(input: {
  workspaceId: string;
  requestedByAgentName?: string;
  documentId?: string;
}): DocumentPermissionRequestRecord[] {
  return listStoredDocumentPermissionRequestsSync({
    workspaceId: input.workspaceId,
    requestedByAgentName: input.requestedByAgentName,
    documentId: input.documentId,
  });
}

export function resolveAgentDocumentRejectionContextSync(input: {
  workspaceId: string;
  agentName: string;
  documentId?: string;
}): DocumentPermissionRequestRecord[] {
  return listStoredDocumentPermissionRequestsSync({
    workspaceId: input.workspaceId,
    requestedByAgentName: input.agentName,
    documentId: input.documentId,
  }).filter((request) => request.status === "rejected");
}

function ensurePermissionRequestHasDocument(
  workspaceId: string,
  request: DocumentPermissionRequestRecord,
  decidedByUserId: string,
): DocumentPermissionRequestRecord {
  if (request.documentId) {
    assertDocumentExists(workspaceId, request.documentId);
    return request;
  }
  if (request.externalProvider !== "google_workspace") {
    throw new Error("Cannot approve an external document permission request before it is linked to a channel document.");
  }

  const externalFileId = normalizeOptional(request.externalFileId) ?? extractGoogleWorkspaceFileId(request.externalUrl);
  const externalUrl = normalizeOptional(request.externalUrl) ?? buildGoogleWorkspaceUrl(externalFileId, "sheet");
  const targetChannelName = normalizeOptional(request.requestedForChannelName);
  if (!externalFileId || !externalUrl || !targetChannelName) {
    throw new Error("External document permission approval requires externalFileId/externalUrl and requestedForChannelName.");
  }

  const existing = findExternalGoogleWorkspaceDocument(workspaceId, externalFileId, targetChannelName);
  if (existing) {
    return linkDocumentPermissionRequestDocumentSync({
      requestId: request.id,
      documentId: existing.id,
    });
  }

  const kind = inferGoogleWorkspaceDocumentKind(request.externalUrl);
  const creator = resolveApprovalDocumentCreator(workspaceId, targetChannelName, request, decidedByUserId);
  const created = kind === "document"
    ? createExternalGoogleDocChannelDocumentSync({
        channelName: targetChannelName,
        title: buildExternalRequestDocumentTitle(request, "Google Doc"),
        externalFileId,
        externalUrl,
        summary: request.reason,
        createdBy: creator.createdBy,
        createdByType: creator.createdByType,
      }, workspaceId)
    : createExternalGoogleSheetChannelDocumentSync({
        channelName: targetChannelName,
        title: buildExternalRequestDocumentTitle(request, "Google Sheet"),
        externalFileId,
        externalUrl,
        summary: request.reason,
        createdBy: creator.createdBy,
        createdByType: creator.createdByType,
      }, workspaceId);

  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "External document linked for permission approval",
    note: `Linked external ${kind === "document" ? "Google Doc" : "Google Sheet"} for ${request.requestedByAgentName}.`,
    code: "document_permission.external_document_linked",
    data: {
      requestId: request.id,
      documentId: created.document.id,
      externalFileId,
      requestedByAgentName: request.requestedByAgentName,
      decidedByUserId,
      targetChannelName,
    },
  });

  return linkDocumentPermissionRequestDocumentSync({
    requestId: request.id,
    documentId: created.document.id,
  });
}

function assertCanDecideDocumentPermissionRequest(input: {
  workspaceId: string;
  request: DocumentPermissionRequestRecord;
  decidedByUserId: string;
}): void {
  if (canDecideDocumentPermissionRequest(input)) {
    return;
  }
  throw new Error("Only workspace managers, document owners, or Google credential owners can decide this document permission request.");
}

function canDecideDocumentPermissionRequest(input: {
  workspaceId: string;
  request: DocumentPermissionRequestRecord;
  decidedByUserId: string;
}): boolean {
  const membership = readWorkspaceMembershipSync(input.workspaceId, input.decidedByUserId);
  if (!membership) {
    return false;
  }
  if (membership.role === "owner" || membership.role === "admin") {
    return true;
  }

  const decider = readUserSync(input.decidedByUserId);
  const deciderDisplayName = decider?.displayName.trim();
  const document = input.request.documentId
    ? tryReadChannelDocument(input.workspaceId, input.request.documentId)
    : undefined;
  if (document && deciderDisplayName) {
    const access = readWorkspaceStateSync(input.workspaceId).channelDocumentAccesses.find((item) =>
      item.documentId === document.id &&
      item.actorType === "human" &&
      sameValue(item.actorId, deciderDisplayName) &&
      allowsDocumentAction(item.role, "manage"),
    );
    if (access) {
      return true;
    }
  }

  if (
    input.request.externalProvider === "google_workspace" &&
    (input.request.externalFileId || input.request.externalUrl) &&
    userHasActiveGoogleCredentialForWorkspace(input.workspaceId, input.decidedByUserId)
  ) {
    return true;
  }

  return false;
}

function userHasActiveGoogleCredentialForWorkspace(workspaceId: string, userId: string): boolean {
  return listGoogleOAuthCredentialsSync(workspaceId).some((credential) =>
    credential.userId === userId &&
    credential.status === "active" &&
    Boolean(credential.refreshTokenEncrypted),
  );
}

function resolveDocumentPermissionApproverRecipients(
  workspaceId: string,
  request: DocumentPermissionRequestRecord,
  document: ChannelDocument | undefined,
): Array<{ userId: string; displayName?: string }> {
  const recipients = new Map<string, { userId: string; displayName?: string }>();
  for (const membership of listWorkspaceMembershipsSync(workspaceId)) {
    if (membership.role !== "owner" && membership.role !== "admin") {
      continue;
    }
    const user = readUserSync(membership.userId);
    recipients.set(membership.userId, {
      userId: membership.userId,
      displayName: user?.displayName,
    });
  }

  if (document) {
    const state = readWorkspaceStateSync(workspaceId);
    for (const access of state.channelDocumentAccesses) {
      if (
        access.documentId !== document.id ||
        access.actorType !== "human" ||
        !allowsDocumentAction(access.role, "manage")
      ) {
        continue;
      }
      const user = findWorkspaceUserByDisplayName(workspaceId, access.actorId);
      if (user) {
        recipients.set(user.id, { userId: user.id, displayName: user.displayName });
      }
    }
  }

  if (request.externalProvider === "google_workspace" && (request.externalFileId || request.externalUrl)) {
    for (const credential of listGoogleOAuthCredentialsSync(workspaceId)) {
      if (credential.status !== "active" || !credential.refreshTokenEncrypted) {
        continue;
      }
      const user = readUserSync(credential.userId);
      recipients.set(credential.userId, { userId: credential.userId, displayName: user?.displayName });
    }
  }

  return Array.from(recipients.values());
}

function notifyDocumentPermissionDecision(
  workspaceId: string,
  request: DocumentPermissionRequestRecord,
  document: ChannelDocument | undefined,
  decision: "approved" | "rejected",
  decidedByUserId: string,
): void {
  const decider = readUserSync(decidedByUserId);
  const agentOwner = resolveAgentOwnerUser(workspaceId, request.requestedByAgentName);
  const title = decision === "approved" ? "Document permission approved" : "Document permission rejected";
  const body = decision === "approved"
    ? `${request.requestedByAgentName} was granted ${request.requestedRole}${document ? ` access to "${document.title}"` : " document access"}.`
    : `${decider?.displayName ?? "A reviewer"} rejected ${request.requestedByAgentName}'s ${request.requestedRole} document access request.`;
  createNotificationsSync([
    {
      workspaceId,
      recipientType: "agent",
      recipientId: request.requestedByAgentName,
      actorType: "human",
      actorId: decidedByUserId,
      type: decision === "approved" ? "document_permission.approved" : "document_permission.rejected",
      resourceType: "approval",
      resourceId: request.id,
      channelName: request.requestedForChannelName ?? document?.channelName,
      title,
      body,
      actionHref: request.requestedForChannelName
        ? `/im?focus=${encodeURIComponent(`channel:${request.requestedForChannelName}`)}`
        : "/inbox",
      severity: decision === "approved" ? "success" : "warning",
      dedupeKey: `document_permission.${decision}:${workspaceId}:${request.id}:${request.requestedByAgentName}`,
      metadata: {
        requestId: request.id,
        documentId: request.documentId,
        documentTitle: document?.title,
        requestedByAgentName: request.requestedByAgentName,
        requestedRole: request.requestedRole,
        decidedByUserId,
        decisionNote: request.decisionNote,
      },
    },
    ...(agentOwner
      ? [{
          workspaceId,
          recipientType: "human" as const,
          recipientId: agentOwner.id,
          actorType: "human" as const,
          actorId: decidedByUserId,
          type: decision === "approved" ? "document_permission.approved.owner" : "document_permission.rejected.owner",
          resourceType: "approval" as const,
          resourceId: request.id,
          channelName: request.requestedForChannelName ?? document?.channelName,
          title,
          body,
          actionHref: request.requestedForChannelName
            ? `/im?focus=${encodeURIComponent(`channel:${request.requestedForChannelName}`)}`
            : "/inbox",
          severity: decision === "approved" ? "success" as const : "warning" as const,
          dedupeKey: `document_permission.${decision}.owner:${workspaceId}:${request.id}:${agentOwner.id}`,
          metadata: {
            requestId: request.id,
            documentId: request.documentId,
            documentTitle: document?.title,
            requestedByAgentName: request.requestedByAgentName,
            requestedRole: request.requestedRole,
            decidedByUserId,
            decisionNote: request.decisionNote,
          },
        }]
      : []),
  ]);
}

function resolveAgentOwnerUser(workspaceId: string, agentName: string): { id: string; displayName: string } | null {
  const employee = readWorkspaceStateSync(workspaceId).activeEmployees.find((item) => sameValue(item.name, agentName));
  if (!employee?.ownerUserId) {
    return null;
  }
  const user = readUserSync(employee.ownerUserId);
  return user ? { id: user.id, displayName: user.displayName } : null;
}

function findWorkspaceUserByDisplayName(workspaceId: string, displayName: string): { id: string; displayName: string } | null {
  const normalized = displayName.trim();
  if (!normalized) {
    return null;
  }
  for (const membership of listWorkspaceMembershipsSync(workspaceId)) {
    const user = readUserSync(membership.userId);
    if (user && sameValue(user.displayName, normalized)) {
      return { id: user.id, displayName: user.displayName };
    }
  }
  return null;
}

function findExternalGoogleWorkspaceDocument(
  workspaceId: string,
  externalFileId: string,
  channelName: string,
): ChannelDocument | undefined {
  return readWorkspaceStateSync(workspaceId).channelDocuments.find((document) =>
    document.status === "active" &&
    sameValue(document.channelName, channelName) &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace" &&
    document.externalFileId === externalFileId,
  );
}

function resolveApprovalDocumentCreator(
  workspaceId: string,
  targetChannelName: string,
  request: DocumentPermissionRequestRecord,
  decidedByUserId: string,
): {
  createdBy: string;
  createdByType: "human" | "agent";
} {
  const state = readWorkspaceStateSync(workspaceId);
  const channel = state.channels.find((item) => sameValue(item.name, targetChannelName));
  const visibleHumanNames = channel ? resolveChannelHumanMemberNames(state, channel) : [];
  const decider = readUserSync(decidedByUserId);
  const deciderDisplayName = decider?.displayName.trim();
  const deciderChannelName = deciderDisplayName && visibleHumanNames.find((name) => sameValue(name, deciderDisplayName));
  if (deciderChannelName) {
    return {
      createdBy: deciderChannelName,
      createdByType: "human",
    };
  }
  if (visibleHumanNames[0]) {
    return {
      createdBy: visibleHumanNames[0],
      createdByType: "human",
    };
  }

  const agent = state.activeEmployees.find((employee) =>
    sameValue(employee.name, request.requestedByAgentName) &&
    employee.channels.some((channelName) => sameValue(channelName, targetChannelName)),
  );
  if (agent) {
    return {
      createdBy: agent.name,
      createdByType: "agent",
    };
  }

  throw new Error(`No actor can create channel documents in ${targetChannelName}.`);
}

function inferGoogleWorkspaceDocumentKind(externalUrl: string | undefined): "sheet" | "document" {
  return externalUrl?.includes("/document/d/") ? "document" : "sheet";
}

function buildExternalRequestDocumentTitle(
  request: DocumentPermissionRequestRecord,
  fallbackPrefix: "Google Sheet" | "Google Doc",
): string {
  const externalFileId = normalizeOptional(request.externalFileId) ?? extractGoogleWorkspaceFileId(request.externalUrl);
  return `${fallbackPrefix} ${externalFileId ?? request.id}`.trim();
}

function buildGoogleWorkspaceUrl(
  externalFileId: string | undefined,
  kind: "sheet" | "document",
): string | undefined {
  if (!externalFileId) {
    return undefined;
  }
  const path = kind === "document" ? "document" : "spreadsheets";
  return `https://docs.google.com/${path}/d/${encodeURIComponent(externalFileId)}/edit`;
}

function resolveExplicitRoleForContext(
  role: AgentAssignableDocumentAccessRole | undefined,
  document: ChannelDocument,
  channelName: string | undefined,
): AgentAssignableDocumentAccessRole | undefined {
  if (!role) {
    return undefined;
  }
  if (!channelName || sameValue(document.channelName, channelName)) {
    return role;
  }
  return role === "forwarder" ? role : undefined;
}

function resolveAgentDocumentForAction(input: {
  workspaceId: string;
  agentName: string;
  action: DocumentAction;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  channelName?: string;
}): AgentDocumentContext | undefined {
  const contexts = resolveAgentDocumentContextSync({
    workspaceId: input.workspaceId,
    agentName: input.agentName,
    channelName: input.channelName,
    documentIds: input.documentId ? [input.documentId] : undefined,
  });
  if (input.documentId) {
    return contexts.find((context) => context.document.id === input.documentId);
  }
  if (input.externalProvider && input.externalFileId) {
    return contexts.find((context) =>
      context.document.externalProvider === input.externalProvider &&
      context.document.externalFileId === input.externalFileId,
    );
  }
  return undefined;
}

function resolveChannelContextRole(
  state: ReturnType<typeof readWorkspaceStateSync>,
  document: ChannelDocument,
  agentName: string,
): DocumentAccessRole | undefined {
  const access = state.channelDocumentAccesses.find((item) =>
    item.documentId === document.id &&
    item.actorType === "agent" &&
    sameValue(item.actorId, agentName),
  );
  if (access?.role === "owner") {
    return undefined;
  }
  return access?.role ?? "editor";
}

function agentBelongsToChannel(
  state: ReturnType<typeof readWorkspaceStateSync>,
  agentName: string,
  channelName: string,
): boolean {
  const employee = state.activeEmployees.find((item) => sameValue(item.name, agentName));
  return Boolean(employee?.channels.some((name) => sameValue(name, channelName)));
}

function maxDocumentRole(
  left: DocumentAccessRole | undefined,
  right: DocumentAccessRole | undefined,
): DocumentAccessRole | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return roleRank(left) <= roleRank(right) ? left : right;
}

function roleRank(role: DocumentAccessRole): number {
  if (role === "owner") {
    return 0;
  }
  if (role === "forwarder") {
    return 1;
  }
  if (role === "editor") {
    return 2;
  }
  return 3;
}

function assertAgentAssignableRole(role: string): asserts role is AgentAssignableDocumentAccessRole {
  if (role !== "viewer" && role !== "editor" && role !== "forwarder") {
    throw new Error("Agents can only request or receive viewer, editor, or forwarder access.");
  }
}

function assertDocumentExists(workspaceId: string, documentId: string): void {
  readChannelDocumentSync(documentId, workspaceId);
}

function tryReadChannelDocument(workspaceId: string, documentId: string): ChannelDocument | undefined {
  try {
    return readChannelDocumentSync(documentId, workspaceId).document;
  } catch {
    return undefined;
  }
}

function postRequestDecisionMessage(
  workspaceId: string,
  request: DocumentPermissionRequestRecord,
  document: ChannelDocument | undefined,
  decision: "approved" | "rejected",
): void {
  const channelName = request.requestedForChannelName ?? document?.channelName;
  if (!channelName) {
    return;
  }
  postSystemMessageSafely({
    workspaceId,
    channelName,
    summary:
      decision === "approved"
        ? `${request.requestedByAgentName} document ${request.requestedRole} access was approved.`
        : `${request.requestedByAgentName} document ${request.requestedRole} access was rejected${request.decisionNote ? `: ${request.decisionNote}` : "."}`,
    code: decision === "approved" ? "document_permission.approved" : "document_permission.rejected",
    data: {
      requestId: request.id,
      documentId: request.documentId,
      requestedRole: request.requestedRole,
      requestedByAgentName: request.requestedByAgentName,
      decision,
    },
  });
}

function postSystemMessageSafely(input: {
  workspaceId: string;
  channelName: string;
  summary: string;
  code: string;
  data: Record<string, string | undefined>;
}): void {
  postNotificationChannelMessageSync({
    workspaceId: input.workspaceId,
    channelName: input.channelName,
    summary: input.summary,
    code: input.code,
    data: input.data,
  });
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function extractGoogleWorkspaceFileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /\/(?:spreadsheets|document)\/d\/([^/?#]+)/.exec(trimmed);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}
