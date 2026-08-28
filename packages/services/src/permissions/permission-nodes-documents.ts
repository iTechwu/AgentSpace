// 文档与文件域权限树节点构建：文档/权限申请/外部文档/消息附件节点。
import type {
  ChannelDocument,
  MessageAttachment,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import {
  sameValue,
} from "../shared/helpers.ts";
import {
  canActorDecideDocumentPermissionRequest,
  canReadDirectChannelForPermissionActor,
  documentAccessVisibleToActor,
  documentVisibleToActor,
  getDocumentAgentAccessForDocument,
  getDocumentPermissionRequestsForDocument,
} from "./permission-context.ts";
import type {
  PermissionBinding,
  PermissionBuildContext,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  buildWorkspaceManagerInheritedBindings,
  externalDocumentNodeId,
  memberLabel,
  normalizeKey,
} from "./permission-utils.ts";

export function buildDocumentAndFileNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const state = context.state;
  const readableChannels = context.visibleChannels.filter((channel) =>
    channel.kind !== "direct" ||
    canReadDirectChannelForPermissionActor(context, channel),
  );
  const visibleChannelNames = new Set(readableChannels.map((channel) => normalizeKey(channel.name)));
  const visibleEmployeeNames = new Set(context.visibleEmployees.map((employee) => normalizeKey(employee.name)));
  const documentNodes = state.channelDocuments
    .filter((document) => visibleChannelNames.has(normalizeKey(document.channelName)))
    .filter((document) => context.isManager || documentVisibleToActor(document, context))
    .map((document) => buildDocumentNode(context, document));
  const fileNodes = state.messages
    .filter((message) => message.channel && visibleChannelNames.has(normalizeKey(message.channel)))
    .flatMap((message) => buildFileNodesForMessage(context, message, visibleEmployeeNames));

  return [...documentNodes, ...fileNodes];
}

function buildDocumentNode(
  context: PermissionBuildContext,
  document: ChannelDocument,
): PermissionTreeNode {
  const state = context.state;
  const accesses = state.channelDocumentAccesses
    .filter((access) => access.documentId === document.id)
    .filter((access) => context.isManager || documentAccessVisibleToActor(access, context));
  const agentAccesses = getDocumentAgentAccessForDocument(context, document.id)
    .filter((access) =>
      context.isManager ||
      context.visibleEmployees.some((employee) => sameValue(employee.name, access.subjectId)),
    );
  const collaboratorBindings: PermissionBinding[] = accesses.map((access) => {
    const member = access.actorType === "human"
      ? context.memberByDisplayName.get(normalizeKey(access.actorId))
      : undefined;
    const employee = access.actorType === "agent"
      ? context.visibleEmployees.find((item) => sameValue(item.name, access.actorId))
      : undefined;
    return {
      subjectType: access.actorType,
      subjectId: member?.userId ?? (access.actorType === "human" ? `human:${access.actorId}` : access.actorId),
      subjectLabel: member ? memberLabel(member) : employee?.remarkName ?? access.actorId,
      permission: access.role,
      source: "document_collaborator",
      status: "active",
      editable: context.isManager || access.actorId === context.actor.displayName,
      updateAction: "document_collaborator_role",
      revokeAction: "document_collaborator_remove",
      lastChangedAt: access.updatedAt,
      metadata: {
        documentId: document.id,
        actorId: access.actorId,
        actorType: access.actorType,
        role: access.role,
      },
    } satisfies PermissionBinding;
  });
  const agentAccessBindings: PermissionBinding[] = agentAccesses.map((access) => {
    const employee = context.visibleEmployees.find((item) => sameValue(item.name, access.subjectId));
    return {
      subjectType: "agent",
      subjectId: access.subjectId,
      subjectLabel: employee?.remarkName ?? access.subjectId,
      permission: access.role,
      source: "document_agent_access",
      status: access.revokedAt ? "revoked" : "active",
      editable: context.isManager && !access.revokedAt,
      updateAction: context.isManager && !access.revokedAt ? "document_agent_access_role" : undefined,
      revokeAction: context.isManager && !access.revokedAt ? "document_agent_access_revoke" : undefined,
      lastChangedAt: access.updatedAt,
      metadata: {
        grantId: access.id,
        documentId: access.documentId,
        actorId: access.subjectId,
        actorType: "agent",
        role: access.role,
        grantedByUserId: access.grantedByUserId,
      },
    } satisfies PermissionBinding;
  });
  const externalChild = document.storageMode === "external" && document.externalProvider
    ? [buildExternalDocumentNode(context, document)]
    : [];

  return {
    id: `document:${document.id}`,
    parentId: `channel:${document.channelName}`,
    resourceType: "document",
    label: document.title,
    status: document.status === "archived" ? "revoked" : document.externalSyncStatus === "permission_error" ? "error" : "active",
    source: "document_collaborator",
    metadata: {
      documentId: document.id,
      channelName: document.channelName,
      kind: document.kind,
      storageMode: document.storageMode,
      externalProvider: document.externalProvider ?? null,
      externalSyncStatus: document.externalSyncStatus ?? null,
    },
    bindings: [
      ...collaboratorBindings,
      ...agentAccessBindings,
      ...buildDocumentPermissionRequestBindings(context, document),
    ],
    children: externalChild,
  };
}

function buildDocumentPermissionRequestBindings(
  context: PermissionBuildContext,
  document: ChannelDocument,
): PermissionBinding[] {
  return getDocumentPermissionRequestsForDocument(context, document.id).filter((request) =>
    context.isManager ||
    context.visibleEmployees.some((employee) => sameValue(employee.name, request.requestedByAgentName)),
  ).map((request) => {
    const employee = context.visibleEmployees.find((item) => sameValue(item.name, request.requestedByAgentName));
    const canDecide = canActorDecideDocumentPermissionRequest(context, request, document);
    return {
      subjectType: "agent",
      subjectId: request.requestedByAgentName,
      subjectLabel: employee?.remarkName ?? request.requestedByAgentName,
      permission: `requested ${request.requestedRole}`,
      source: "document_permission_request",
      status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
      editable: canDecide && request.status === "pending",
      updateAction: canDecide && request.status === "pending" ? "document_permission_request_approve" : undefined,
      revokeAction: canDecide && request.status === "pending" ? "document_permission_request_reject" : undefined,
      lastChangedAt: request.decidedAt ?? request.createdAt,
      metadata: {
        requestId: request.id,
        documentId: document.id,
        actorId: request.requestedByAgentName,
        actorType: "agent",
        role: request.requestedRole,
        targetChannel: request.requestedForChannelName ?? null,
        status: request.status,
        reason: request.reason,
      },
    } satisfies PermissionBinding;
  });
}

export function buildDocumentPermissionRequestNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const state = context.state;
  const documentById = new Map(state.channelDocuments.map((document) => [document.id, document]));
  return context.documentPermissionRequests.filter((request) =>
    (!request.documentId || !documentById.has(request.documentId)) &&
    (context.isManager || canActorDecideDocumentPermissionRequest(context, request))
  ).map((request) => {
    const employee = context.visibleEmployees.find((item) => sameValue(item.name, request.requestedByAgentName));
    const canDecide = canActorDecideDocumentPermissionRequest(context, request);
    return {
      id: `document-permission-request:${request.id}`,
      parentId: context.workspaceNodeId,
      resourceType: "document",
      label: request.externalUrl ?? request.externalFileId ?? request.id,
      status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
      source: "document_permission_request",
      metadata: {
        requestId: request.id,
        documentId: request.documentId ?? null,
        externalProvider: request.externalProvider ?? null,
        externalFileId: request.externalFileId ?? null,
        externalUrl: request.externalUrl ?? null,
        targetChannel: request.requestedForChannelName ?? null,
      },
      bindings: [{
        subjectType: "agent",
        subjectId: request.requestedByAgentName,
        subjectLabel: employee?.remarkName ?? request.requestedByAgentName,
        permission: `requested ${request.requestedRole}`,
        source: "document_permission_request",
        status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
        editable: canDecide && request.status === "pending",
        updateAction: canDecide && request.status === "pending" ? "document_permission_request_approve" : undefined,
        revokeAction: canDecide && request.status === "pending" ? "document_permission_request_reject" : undefined,
        lastChangedAt: request.decidedAt ?? request.createdAt,
        metadata: {
          requestId: request.id,
          actorId: request.requestedByAgentName,
          actorType: "agent",
          role: request.requestedRole,
          status: request.status,
          reason: request.reason,
          targetChannel: request.requestedForChannelName ?? null,
        },
      }],
    } satisfies PermissionTreeNode;
  });
}

function buildExternalDocumentNode(
  context: PermissionBuildContext,
  document: ChannelDocument,
): PermissionTreeNode {
  return {
    id: externalDocumentNodeId(document),
    parentId: `document:${document.id}`,
    resourceType: "external_document",
    label: `External: ${document.title}`,
    status: document.externalSyncStatus === "permission_error" ? "error" : document.externalSyncStatus === "missing" ? "error" : "active",
    source: "external_document_permission",
    metadata: {
      documentId: document.id,
      channelName: document.channelName,
      externalProvider: document.externalProvider ?? null,
      externalFileId: document.externalFileId ?? null,
      externalSyncStatus: document.externalSyncStatus ?? "unknown",
    },
    bindings: [
      {
        subjectType: "system",
        subjectId: "external_document_permission_sync",
        subjectLabel: "External document permission sync",
        permission: document.externalSyncStatus ?? "unknown",
        source: "external_document_permission",
        status: "external",
        editable: context.isManager,
        updateAction: context.isManager ? "external_document_permission_sync" : undefined,
        lastChangedAt: document.externalUpdatedAt ?? document.updatedAt,
        metadata: {
          documentId: document.id,
        },
      },
    ],
  };
}

function buildFileNodesForMessage(
  context: PermissionBuildContext,
  message: WorkspaceMessage,
  visibleEmployeeNames: Set<string>,
): PermissionTreeNode[] {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }
  if (!context.isManager && message.role === "agent" && !visibleEmployeeNames.has(normalizeKey(message.speaker))) {
    return [];
  }
  if (!context.isManager && message.role === "human" && message.speakerUserId !== context.actor.userId) {
    return [];
  }

  return attachments.map((attachment) => buildFileNode(context, message, attachment));
}

function buildFileNode(
  context: PermissionBuildContext,
  message: WorkspaceMessage,
  attachment: MessageAttachment,
): PermissionTreeNode {
  const uploaderMember = message.speakerUserId ? context.memberByUserId.get(message.speakerUserId) : undefined;
  const bindings: PermissionBinding[] = [];
  if (uploaderMember) {
    bindings.push({
      subjectType: "human",
      subjectId: uploaderMember.userId,
      subjectLabel: memberLabel(uploaderMember),
      permission: message.role === "human" ? "uploader delete" : "agent output viewer",
      source: "derived",
      status: attachment.deletedAt ? "revoked" : "active",
      editable: context.isManager || uploaderMember.userId === context.actor.userId,
      revokeAction: message.role === "human" && !attachment.deletedAt ? "file_delete" : undefined,
      lastChangedAt: attachment.deletedAt ?? message.time,
      metadata: {
        attachmentId: attachment.id,
        channelName: message.channel ?? null,
      },
    });
  }
  if (context.isManager) {
    bindings.push(...buildWorkspaceManagerInheritedBindings(context, "delete file"));
  }

  return {
    id: `file:${attachment.id}`,
    parentId: message.channel ? `channel:${message.channel}` : context.workspaceNodeId,
    resourceType: "file",
    label: attachment.fileName,
    status: attachment.deletedAt ? "revoked" : "active",
    source: "derived",
    metadata: {
      attachmentId: attachment.id,
      channelName: message.channel ?? null,
      messageId: message.id,
      sizeBytes: attachment.sizeBytes,
      mediaType: attachment.mediaType,
      deletedAt: attachment.deletedAt ?? null,
    },
    bindings,
  };
}
