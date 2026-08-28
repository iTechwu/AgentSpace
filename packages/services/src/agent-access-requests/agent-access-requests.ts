import {
  approveAgentAccessRequestSync as approveStoredAgentAccessRequestSync,
  cancelAgentAccessRequestSync as cancelStoredAgentAccessRequestSync,
  createAgentAccessRequestSync as createStoredAgentAccessRequestSync,
  listAgentAccessRequestsSync as listStoredAgentAccessRequestsSync,
  listWorkspaceMemberUsersSync,
  readAgentAccessRequestSync,
  readStoredEmployeeSync,
  readUserSync,
  readWorkspaceMembershipSync,
  rejectAgentAccessRequestSync as rejectStoredAgentAccessRequestSync,
  type AgentAccessRequestRecord,
  type AgentAccessRequestStatus,
  type AgentAccessRequestType,
} from "@dofe-agent/db";
import { createAgentForkInvitationForActorSync } from "../agent-forks/agent-forks.ts";
import { canReadChannelForActorSync } from "../channel-access/channel-access.ts";
import { setEmployeeChannelMemberAccessSync } from "../employees/employees.ts";
import { createNotificationsSync, createNotificationSync } from "../notifications/notifications.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { sameValue } from "../shared/helpers.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";

export type {
  AgentAccessRequestRecord,
  AgentAccessRequestStatus,
  AgentAccessRequestType,
};

export function createAgentAccessRequestForActorSync(input: {
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType?: AgentAccessRequestType;
  targetChannelName?: string;
  reason?: string;
}): AgentAccessRequestRecord {
  const workspaceId = input.workspaceId;
  const sourceAgentName = normalizeRequired(input.sourceAgentName, "sourceAgentName");
  const requesterUserId = normalizeRequired(input.requesterUserId, "requesterUserId");
  const requestType = input.requestType ?? "fork_copy";
  const targetChannelName = requestType === "channel_use"
    ? normalizeRequired(input.targetChannelName ?? "", "targetChannelName")
    : normalizeOptional(input.targetChannelName);
  if (requestType !== "fork_copy" && requestType !== "channel_use") {
    throw new Error("agent_access_request.unsupported_request_type");
  }
  assertActiveWorkspaceMember(workspaceId, requesterUserId);
  const sourceAgent = readStoredEmployeeSync(sourceAgentName, workspaceId);
  if (!sourceAgent) {
    throw new Error("agent_access_request.source_not_found");
  }
  if (sourceAgent.ownerUserId === requesterUserId) {
    throw new Error("agent_access_request.self_owned_agent");
  }
  if (requestType === "channel_use") {
    const channelUseTarget = normalizeRequired(targetChannelName ?? "", "targetChannelName");
    assertChannelUseRequestable({
      workspaceId,
      sourceAgentName: sourceAgent.name,
      requesterUserId,
      targetChannelName: channelUseTarget,
      rejectAlreadyEnabled: true,
    });
  }

  const created = createStoredAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: sourceAgent.name,
    requesterUserId,
    requestType,
    targetChannelName,
    reason: input.reason,
    auditDataJson: JSON.stringify({
      createdBy: "requester",
      sourceOwnerUserId: sourceAgent.ownerUserId ?? null,
      targetChannelName: targetChannelName ?? null,
    }),
  });

  if (!created.created) {
    return created.request;
  }

  const requester = readUserSync(requesterUserId);
  const reviewers = resolveAgentAccessRequestReviewerUserIds(workspaceId, sourceAgent.ownerUserId)
    .filter((userId) => userId !== requesterUserId);
  createNotificationsSync(reviewers.map((recipientId) => ({
    workspaceId,
    recipientType: "human",
    recipientId,
    actorType: "human",
    actorId: requesterUserId,
    type: "agent.access_request_created",
    resourceType: "approval",
    resourceId: created.request.id,
    title: "Agent access requested",
    body: buildAgentAccessRequestCreatedBody({
      requesterDisplayName: requester?.displayName,
      sourceAgentDisplayName: sourceAgent.remarkName ?? sourceAgent.name,
      requestType,
      targetChannelName,
    }),
    actionHref: "/agents?mode=showcase",
    severity: "warning",
    dedupeKey: `agent.access_request_created:${workspaceId}:${created.request.id}:${recipientId}`,
    metadata: {
      requestId: created.request.id,
      sourceAgentName: sourceAgent.name,
      requesterUserId,
      requestType,
      targetChannelName,
    },
  })));
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Agent access request created",
    note: `${requester?.displayName ?? requesterUserId} requested ${requestType} access to "${sourceAgent.name}".`,
    code: "agent.access_request_created",
    data: {
      requestId: created.request.id,
      sourceAgentName: sourceAgent.name,
      requesterUserId,
      requestType,
      targetChannelName: targetChannelName ?? "",
      reviewerUserIds: reviewers.join(","),
    },
  });

  return created.request;
}

export function approveAgentAccessRequestForActorSync(input: {
  workspaceId: string;
  requestId: string;
  actorUserId: string;
}): AgentAccessRequestRecord {
  const before = readAgentAccessRequestForDecision(input.workspaceId, input.requestId);
  assertCanDecideAgentAccessRequest({
    workspaceId: input.workspaceId,
    request: before,
    actorUserId: input.actorUserId,
  });
  if (before.requestType === "channel_use") {
    return approveChannelUseAgentAccessRequestForActorSync({
      workspaceId: input.workspaceId,
      request: before,
      actorUserId: input.actorUserId,
    });
  }
  if (before.requestType !== "fork_copy") {
    throw new Error("agent_access_request.unsupported_request_type");
  }
  const sourceAgent = readStoredEmployeeSync(before.sourceAgentName, input.workspaceId);
  if (!sourceAgent) {
    throw new Error("agent_access_request.source_not_found");
  }

  const invitation = createAgentForkInvitationForActorSync({
    workspaceId: input.workspaceId,
    sourceAgentName: before.sourceAgentName,
    targetUserId: before.requesterUserId,
    actorUserId: input.actorUserId,
    options: {
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
      contextNote: before.reason || "Approved from an agent access request.",
    },
  });
  const request = approveStoredAgentAccessRequestSync({
    workspaceId: input.workspaceId,
    requestId: before.id,
    resolverUserId: input.actorUserId,
    forkInvitationId: invitation.id,
    auditDataJson: JSON.stringify({
      forkInvitationId: invitation.id,
      resolvedBy: input.actorUserId,
    }),
  });
  const actor = readUserSync(input.actorUserId);
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: request.requesterUserId,
    actorType: "human",
    actorId: input.actorUserId,
    type: "agent.access_request_approved",
    resourceType: "agent_fork_invitation",
    resourceId: invitation.id,
    title: "Agent copy request approved",
    body: `${actor?.displayName ?? "A workspace manager"} approved your copy request for ${sourceAgent.remarkName ?? sourceAgent.name}.`,
    actionHref: "/agents?mode=agent",
    severity: "success",
    dedupeKey: `agent.access_request_approved:${input.workspaceId}:${request.id}:${request.requesterUserId}`,
    metadata: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requestType: request.requestType,
      forkInvitationId: invitation.id,
    },
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Agent access request approved",
    note: `Agent access request "${request.id}" was approved and fork invitation "${invitation.id}" was created.`,
    code: "agent.access_request_approved",
    data: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requesterUserId: request.requesterUserId,
      resolverUserId: input.actorUserId,
      requestType: request.requestType,
      forkInvitationId: invitation.id,
    },
  });
  return request;
}

export function rejectAgentAccessRequestForActorSync(input: {
  workspaceId: string;
  requestId: string;
  actorUserId: string;
}): AgentAccessRequestRecord {
  const before = readAgentAccessRequestForDecision(input.workspaceId, input.requestId);
  assertCanDecideAgentAccessRequest({
    workspaceId: input.workspaceId,
    request: before,
    actorUserId: input.actorUserId,
  });
  const request = rejectStoredAgentAccessRequestSync({
    workspaceId: input.workspaceId,
    requestId: before.id,
    resolverUserId: input.actorUserId,
    auditDataJson: JSON.stringify({
      resolvedBy: input.actorUserId,
    }),
  });
  notifyRequesterOfRejection(input.workspaceId, request, input.actorUserId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Agent access request rejected",
    note: `Agent access request "${request.id}" was rejected.`,
    code: "agent.access_request_rejected",
    data: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requesterUserId: request.requesterUserId,
      resolverUserId: input.actorUserId,
      requestType: request.requestType,
      targetChannelName: request.targetChannelName ?? "",
    },
  });
  return request;
}

export function cancelAgentAccessRequestForActorSync(input: {
  workspaceId: string;
  requestId: string;
  actorUserId: string;
}): AgentAccessRequestRecord {
  const before = readAgentAccessRequestForDecision(input.workspaceId, input.requestId);
  if (
    before.requesterUserId !== input.actorUserId &&
    !canDecideAgentAccessRequest({
      workspaceId: input.workspaceId,
      request: before,
      actorUserId: input.actorUserId,
    })
  ) {
    throw new Error("Only the requester or an agent access manager can cancel this request.");
  }
  const request = cancelStoredAgentAccessRequestSync({
    workspaceId: input.workspaceId,
    requestId: before.id,
    resolverUserId: input.actorUserId,
    auditDataJson: JSON.stringify({
      cancelledBy: input.actorUserId,
    }),
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Agent access request cancelled",
    note: `Agent access request "${request.id}" was cancelled.`,
    code: "agent.access_request_cancelled",
    data: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requesterUserId: request.requesterUserId,
      resolverUserId: input.actorUserId,
      requestType: request.requestType,
      targetChannelName: request.targetChannelName ?? "",
    },
  });
  return request;
}

export function listAgentAccessRequestsForActorSync(input: {
  workspaceId: string;
  actorUserId: string;
  statuses?: AgentAccessRequestStatus[];
}): AgentAccessRequestRecord[] {
  const all = listStoredAgentAccessRequestsSync(input.workspaceId, {
    statuses: input.statuses,
  });
  if (isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    return all;
  }
  const ownedAgentNames = new Set(
    ensureWorkspaceStateSync(input.workspaceId).activeEmployees
      .filter((employee) => employee.ownerUserId === input.actorUserId)
      .map((employee) => employee.name),
  );
  return all.filter((request) =>
    request.requesterUserId === input.actorUserId || ownedAgentNames.has(request.sourceAgentName)
  );
}

export function canDecideAgentAccessRequest(input: {
  workspaceId: string;
  request: AgentAccessRequestRecord;
  actorUserId: string;
}): boolean {
  if (isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    return true;
  }
  const sourceAgent = readStoredEmployeeSync(input.request.sourceAgentName, input.workspaceId);
  return Boolean(sourceAgent?.ownerUserId && sourceAgent.ownerUserId === input.actorUserId);
}

function assertCanDecideAgentAccessRequest(input: {
  workspaceId: string;
  request: AgentAccessRequestRecord;
  actorUserId: string;
}): void {
  if (!canDecideAgentAccessRequest(input)) {
    throw new Error("Only the agent owner or a workspace manager can decide this agent access request.");
  }
}

function readAgentAccessRequestForDecision(workspaceId: string, requestId: string): AgentAccessRequestRecord {
  const request = readAgentAccessRequestSync(requestId, workspaceId);
  if (!request) {
    throw new Error(`Agent access request "${requestId}" does not exist.`);
  }
  if (request.status !== "pending") {
    throw new Error(`Agent access request "${requestId}" is not pending.`);
  }
  return request;
}

function approveChannelUseAgentAccessRequestForActorSync(input: {
  workspaceId: string;
  request: AgentAccessRequestRecord;
  actorUserId: string;
}): AgentAccessRequestRecord {
  const targetChannelName = normalizeRequired(input.request.targetChannelName ?? "", "targetChannelName");
  const sourceAgent = assertChannelUseRequestable({
    workspaceId: input.workspaceId,
    sourceAgentName: input.request.sourceAgentName,
    requesterUserId: input.request.requesterUserId,
    targetChannelName,
    rejectAlreadyEnabled: false,
  });

  if ((sourceAgent.channelMemberAccess ?? (sourceAgent.ownerUserId ? "disabled" : "enabled")) !== "enabled") {
    setEmployeeChannelMemberAccessSync(sourceAgent.name, "enabled", input.workspaceId);
  }

  const request = approveStoredAgentAccessRequestSync({
    workspaceId: input.workspaceId,
    requestId: input.request.id,
    resolverUserId: input.actorUserId,
    auditDataJson: JSON.stringify({
      resolvedBy: input.actorUserId,
      targetChannelName,
      channelMemberAccess: "enabled",
    }),
  });
  const actor = readUserSync(input.actorUserId);
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: request.requesterUserId,
    actorType: "human",
    actorId: input.actorUserId,
    type: "agent.access_request_approved",
    resourceType: "agent",
    resourceId: request.sourceAgentName,
    title: "Agent channel use request approved",
    body: `${actor?.displayName ?? "A workspace manager"} approved your request to use ${sourceAgent.remarkName ?? sourceAgent.name} in #${targetChannelName}.`,
    actionHref: "/agents?mode=showcase",
    severity: "success",
    dedupeKey: `agent.access_request_approved:${input.workspaceId}:${request.id}:${request.requesterUserId}`,
    metadata: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requestType: request.requestType,
      targetChannelName,
    },
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Agent access request approved",
    note: `Agent channel use request "${request.id}" was approved for channel "${targetChannelName}".`,
    code: "agent.access_request_approved",
    data: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requesterUserId: request.requesterUserId,
      resolverUserId: input.actorUserId,
      requestType: request.requestType,
      targetChannelName,
    },
  });
  return request;
}

function assertChannelUseRequestable(input: {
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  targetChannelName: string;
  rejectAlreadyEnabled: boolean;
}) {
  assertActiveWorkspaceMember(input.workspaceId, input.requesterUserId);
  const state = ensureWorkspaceStateSync(input.workspaceId);
  const sourceAgent = state.activeEmployees.find((employee) => sameValue(employee.name, input.sourceAgentName));
  if (!sourceAgent) {
    throw new Error("agent_access_request.source_not_found");
  }
  const channel = state.channels.find((item) => sameValue(item.name, input.targetChannelName));
  if (!channel) {
    throw new Error("agent_access_request.channel_not_found");
  }
  if (channel.kind === "direct") {
    throw new Error("agent_access_request.direct_channel_not_supported");
  }
  if (!sourceAgent.channels.some((channelName) => sameValue(channelName, input.targetChannelName))) {
    throw new Error("agent_access_request.source_not_in_channel");
  }
  const requester = readUserSync(input.requesterUserId);
  const requesterMembership = readWorkspaceMembershipSync(input.workspaceId, input.requesterUserId);
  if (!canReadChannelForActorSync({
    workspaceId: input.workspaceId,
    channelName: input.targetChannelName,
    actor: {
      userId: input.requesterUserId,
      displayName: requester?.displayName,
      role: requesterMembership?.role,
    },
  })) {
    throw new Error("agent_access_request.channel_not_accessible");
  }
  if (
    input.rejectAlreadyEnabled &&
    (sourceAgent.channelMemberAccess ?? (sourceAgent.ownerUserId ? "disabled" : "enabled")) === "enabled"
  ) {
    throw new Error("agent_access_request.channel_use_already_enabled");
  }
  return sourceAgent;
}

function resolveAgentAccessRequestReviewerUserIds(
  workspaceId: string,
  ownerUserId?: string,
): string[] {
  if (ownerUserId) {
    return [ownerUserId];
  }
  return listWorkspaceMemberUsersSync(workspaceId)
    .filter((member) => member.role === "owner" || member.role === "admin")
    .map((member) => member.userId);
}

function notifyRequesterOfRejection(
  workspaceId: string,
  request: AgentAccessRequestRecord,
  actorUserId: string,
): void {
  const actor = readUserSync(actorUserId);
  const sourceAgent = readStoredEmployeeSync(request.sourceAgentName, workspaceId);
  createNotificationSync({
    workspaceId,
    recipientType: "human",
    recipientId: request.requesterUserId,
    actorType: "human",
    actorId: actorUserId,
    type: "agent.access_request_rejected",
    resourceType: "approval",
    resourceId: request.id,
    title: request.requestType === "fork_copy" ? "Agent copy request rejected" : "Agent channel use request rejected",
    body:
      request.requestType === "fork_copy"
        ? `${actor?.displayName ?? "A workspace manager"} rejected your copy request for ${sourceAgent?.remarkName ?? request.sourceAgentName}.`
        : `${actor?.displayName ?? "A workspace manager"} rejected your request to use ${sourceAgent?.remarkName ?? request.sourceAgentName}${request.targetChannelName ? ` in #${request.targetChannelName}` : ""}.`,
    actionHref: "/agents?mode=showcase",
    severity: "warning",
    dedupeKey: `agent.access_request_rejected:${workspaceId}:${request.id}:${request.requesterUserId}`,
    metadata: {
      requestId: request.id,
      sourceAgentName: request.sourceAgentName,
      requestType: request.requestType,
      targetChannelName: request.targetChannelName,
    },
  });
}

function assertActiveWorkspaceMember(workspaceId: string, userId: string): void {
  const membership = readWorkspaceMembershipSync(workspaceId, userId);
  if (!membership || membership.status !== "active") {
    throw new Error(`User "${userId}" is not an active workspace member.`);
  }
}

function normalizeRequired(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function normalizeOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildAgentAccessRequestCreatedBody(input: {
  requesterDisplayName?: string;
  sourceAgentDisplayName: string;
  requestType: AgentAccessRequestType;
  targetChannelName?: string;
}): string {
  const requester = input.requesterDisplayName ?? "A workspace member";
  if (input.requestType === "channel_use") {
    return `${requester} requested channel use of ${input.sourceAgentDisplayName}${input.targetChannelName ? ` in #${input.targetChannelName}` : ""}.`;
  }
  return `${requester} requested a copy of ${input.sourceAgentDisplayName}.`;
}
