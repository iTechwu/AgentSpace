// 权限中心数据源聚合与访问判定：17+ 种数据源聚合为 PermissionBuildContext，并提供频道/文档可见性与决策检查。
import {
  listAgentAccessRequestsSync,
  listAgentForkInvitationsSync,
  listChannelAccessRequestsSync,
  listChannelInvitationsSync,
  listDaemonSnapshotsSync,
  listDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync,
  listEmployeeRuntimeBindingsSync,
  listRuntimeGrantsSync,
  listStoredWorkspaceSkillsSync,
  listWorkspaceChannelParticipantsSync,
  listWorkspaceMemberUsersSync,
  listWorkspaceRuntimeDisplayNamesSync,
} from "@dofe-agent/db";
import type {
  ActiveEmployee,
  ChannelDocument,
  ChannelRecord,
} from "@dofe-agent/domain/workspace";
import {
  resolveChannelHumanMemberNames,
} from "../channels/channels.ts";
import {
  ensureWorkspaceStateSync,
} from "../shared/state-io.ts";
import {
  sameValue,
} from "../shared/helpers.ts";
import type {
  PermissionBuildContext,
  PermissionCenterActorInput,
} from "./permission-types.ts";
import {
  groupByKey,
  groupByNormalizedKey,
  normalizeKey,
} from "./permission-utils.ts";

export function buildPermissionContext(input: {
  workspaceId: string;
  actor: PermissionCenterActorInput;
}): PermissionBuildContext {
  const state = ensureWorkspaceStateSync(input.workspaceId);
  const members = listWorkspaceMemberUsersSync(input.workspaceId).map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    primaryEmail: member.primaryEmail,
    role: member.role,
  }));
  const memberByUserId = new Map(members.map((member) => [member.userId, member]));
  const memberByDisplayName = new Map(members.map((member) => [normalizeKey(member.displayName), member]));
  const isManager = input.actor.role === "owner" || input.actor.role === "admin";
  const channelParticipantsByName = groupByNormalizedKey(
    listWorkspaceChannelParticipantsSync(input.workspaceId, {
      statuses: ["active", "removed"],
    }),
    (participant) => participant.channelName,
  );
  const visibleChannels = state.channels.filter((channel) =>
    isManager || canReadChannelForPermissionActor(channel, input.actor, state, channelParticipantsByName),
  );
  const visibleChannelNames = new Set(visibleChannels.map((channel) => normalizeKey(channel.name)));
  const visibleEmployees = state.activeEmployees.filter((employee) => {
    if (isManager || employee.ownerUserId === input.actor.userId) {
      return true;
    }
    if ((employee.channelMemberAccess ?? "enabled") !== "enabled") {
      return false;
    }
    return employee.channels.some((channelName) => visibleChannelNames.has(normalizeKey(channelName)));
  });
  const visibleEmployeeNames = new Set(visibleEmployees.map((employee) => employee.name));
  const runtimeBindings = listEmployeeRuntimeBindingsSync(input.workspaceId);
  const runtimeGrants = listRuntimeGrantsSync(input.workspaceId);
  const visibleRuntimeIds = new Set<string>();
  for (const grant of runtimeGrants) {
    if (isManager || grant.userId === input.actor.userId) {
      visibleRuntimeIds.add(grant.runtimeId);
    }
  }
  for (const binding of runtimeBindings) {
    if (visibleEmployeeNames.has(binding.employeeName)) {
      visibleRuntimeIds.add(binding.runtimeId);
    }
  }
  const runtimeDisplayNameById = new Map(
    listWorkspaceRuntimeDisplayNamesSync(input.workspaceId).map((record) => [record.runtimeId, record.displayName]),
  );
  const runtimeLabelById = new Map<string, string>();
  for (const snapshot of listDaemonSnapshotsSync(input.workspaceId)) {
    for (const runtime of snapshot.runtimes) {
      runtimeLabelById.set(runtime.id, runtimeDisplayNameById.get(runtime.id) || runtime.name || runtime.id);
    }
  }
  for (const binding of runtimeBindings) {
    if (!runtimeLabelById.has(binding.runtimeId)) {
      runtimeLabelById.set(binding.runtimeId, binding.runtimeName || binding.runtimeId);
    }
  }
  const channelAccessRequestsByName = groupByNormalizedKey(
    listChannelAccessRequestsSync(input.workspaceId, {
      statuses: ["pending", "approved", "rejected", "cancelled"],
    }),
    (request) => request.channelName,
  );
  const channelInvitationsByName = groupByNormalizedKey(
    listChannelInvitationsSync(input.workspaceId, {
      statuses: ["pending", "accepted", "rejected", "revoked", "expired"],
    }),
    (invitation) => invitation.channelName,
  );
  const documentAgentAccesses = listDocumentAgentAccessSync({
    workspaceId: input.workspaceId,
  });
  const documentPermissionRequests = listDocumentPermissionRequestsSync({
    workspaceId: input.workspaceId,
  });
  const agentForkInvitationsBySourceName = groupByNormalizedKey(
    listAgentForkInvitationsSync(input.workspaceId, {
      statuses: ["pending"],
    }),
    (invitation) => invitation.sourceAgentName,
  );
  const agentAccessRequests = listAgentAccessRequestsSync(input.workspaceId, {
    statuses: ["pending", "approved", "rejected", "cancelled"],
  });

  return {
    workspaceId: input.workspaceId,
    actor: input.actor,
    isManager,
    workspaceNodeId: `workspace:${input.workspaceId}`,
    state,
    visibleChannels,
    visibleEmployees,
    visibleRuntimeIds,
    channelParticipantsByName,
    channelAccessRequestsByName,
    channelInvitationsByName,
    documentAgentAccessByDocumentId: groupByKey(documentAgentAccesses, (access) => access.documentId),
    documentAgentAccessBySubjectId: groupByNormalizedKey(documentAgentAccesses, (access) => access.subjectId),
    documentPermissionRequests,
    documentPermissionRequestsByDocumentId: groupByKey(
      documentPermissionRequests.filter((request) => Boolean(request.documentId)),
      (request) => request.documentId ?? "",
    ),
    documentPermissionRequestsByAgentName: groupByNormalizedKey(
      documentPermissionRequests,
      (request) => request.requestedByAgentName,
    ),
    agentForkInvitationsBySourceName,
    agentAccessRequestsBySourceName: groupByNormalizedKey(agentAccessRequests, (request) => request.sourceAgentName),
    agentAccessRequests,
    memberByUserId,
    memberByDisplayName,
    runtimeLabelById,
    skillById: new Map(listStoredWorkspaceSkillsSync(input.workspaceId).map((skill) => [skill.id, skill])),
  };
}

export function canActorDecideDocumentPermissionRequest(
  context: PermissionBuildContext,
  request: ReturnType<typeof listDocumentPermissionRequestsSync>[number],
  document?: ChannelDocument,
): boolean {
  if (context.isManager) {
    return true;
  }
  const resolvedDocument = document ?? (request.documentId
    ? context.state.channelDocuments.find((item) => item.id === request.documentId)
    : undefined);
  if (resolvedDocument) {
    const ownerAccess = context.state.channelDocumentAccesses.find((access) =>
      access.documentId === resolvedDocument.id &&
      access.actorType === "human" &&
      sameValue(access.actorId, context.actor.displayName) &&
      access.role === "owner",
    );
    if (ownerAccess) {
      return true;
    }
  }
  return false;
}

export function canActorSeeAgentAccessRequest(
  context: PermissionBuildContext,
  request: ReturnType<typeof listAgentAccessRequestsSync>[number],
  sourceAgent?: ActiveEmployee,
): boolean {
  return context.isManager ||
    request.requesterUserId === context.actor.userId ||
    canActorDecideAgentAccessRequest(context, request, sourceAgent);
}

export function canActorDecideAgentAccessRequest(
  context: PermissionBuildContext,
  request: ReturnType<typeof listAgentAccessRequestsSync>[number],
  sourceAgent?: ActiveEmployee,
): boolean {
  if (context.isManager) {
    return true;
  }
  const resolvedSource = sourceAgent ?? context.state.activeEmployees.find((employee) => sameValue(employee.name, request.sourceAgentName));
  return Boolean(resolvedSource?.ownerUserId && resolvedSource.ownerUserId === context.actor.userId);
}

export function documentVisibleToActor(document: ChannelDocument, context: PermissionBuildContext): boolean {
  return context.state.channelDocumentAccesses.some(
    (access) =>
      access.documentId === document.id &&
      (
        (access.actorType === "human" && sameValue(access.actorId, context.actor.displayName)) ||
        (access.actorType === "agent" && context.visibleEmployees.some((employee) => sameValue(employee.name, access.actorId)))
      ),
  );
}

export function documentAccessVisibleToActor(
  access: { actorId: string; actorType: "human" | "agent" },
  context: PermissionBuildContext,
): boolean {
  if (access.actorType === "human") {
    const member = context.memberByDisplayName.get(normalizeKey(access.actorId));
    return member?.userId === context.actor.userId || sameValue(access.actorId, context.actor.displayName);
  }
  return context.visibleEmployees.some((employee) => sameValue(employee.name, access.actorId));
}

function canReadChannelForPermissionActor(
  channel: ChannelRecord,
  actor: PermissionCenterActorInput,
  state: PermissionBuildContext["state"],
  channelParticipantsByName: PermissionBuildContext["channelParticipantsByName"],
): boolean {
  if (channel.kind === "direct") {
    return canReadDirectChannelForPermissionActor(
      {
        actor,
        state,
        channelParticipantsByName,
      },
      channel,
    );
  }
  if (actor.role === "owner" || actor.role === "admin") {
    return true;
  }
  if (!actor.userId.trim()) {
    return false;
  }
  const participant = (channelParticipantsByName.get(normalizeKey(channel.name)) ?? [])
    .find((item) => item.userId === actor.userId && item.status === "active");
  if (participant) {
    return true;
  }
  return canReadChannelByLegacyMembership(channel, actor, state, channelParticipantsByName);
}

export function canReadDirectChannelForPermissionActor(
  context: Pick<PermissionBuildContext, "actor" | "state" | "channelParticipantsByName">,
  channel: ChannelRecord,
): boolean {
  const actorUserId = context.actor.userId.trim();
  if (!actorUserId) {
    return false;
  }
  const participant = getChannelParticipants(context, channel.name)
    .find((item) => item.userId === actorUserId && item.status === "active");
  if (participant) {
    return true;
  }

  if (
    resolveChannelHumanMemberNames(context.state, channel)
      .some((name) => sameValue(name, context.actor.displayName))
  ) {
    return true;
  }

  return channel.employeeNames.some((employeeName) => {
    const employee = context.state.activeEmployees.find((item) => sameValue(item.name, employeeName));
    return employee?.ownerUserId === actorUserId;
  });
}

function canReadChannelByLegacyMembership(
  channel: ChannelRecord,
  actor: PermissionCenterActorInput,
  state: PermissionBuildContext["state"],
  channelParticipantsByName: PermissionBuildContext["channelParticipantsByName"],
): boolean {
  if ((channelParticipantsByName.get(normalizeKey(channel.name)) ?? []).length > 0) {
    return false;
  }
  const visibleHumanNames = resolveChannelHumanMemberNames(state, channel);
  if (visibleHumanNames.length === 0) {
    // Memberless channels must default to private (deny); see
    // canReadChannelByLegacyMembership in channel-access.ts.
    return false;
  }
  return visibleHumanNames.some((candidate) => sameValue(candidate, actor.displayName));
}

export function getChannelParticipants(
  context: Pick<PermissionBuildContext, "channelParticipantsByName">,
  channelName: string,
): ReturnType<typeof listWorkspaceChannelParticipantsSync> {
  return context.channelParticipantsByName.get(normalizeKey(channelName)) ?? [];
}

export function getChannelAccessRequests(
  context: PermissionBuildContext,
  channelName: string,
): ReturnType<typeof listChannelAccessRequestsSync> {
  return context.channelAccessRequestsByName.get(normalizeKey(channelName)) ?? [];
}

export function getChannelInvitations(
  context: PermissionBuildContext,
  channelName: string,
): ReturnType<typeof listChannelInvitationsSync> {
  return context.channelInvitationsByName.get(normalizeKey(channelName)) ?? [];
}

export function getDocumentAgentAccessForDocument(
  context: PermissionBuildContext,
  documentId: string,
): ReturnType<typeof listDocumentAgentAccessSync> {
  return context.documentAgentAccessByDocumentId.get(documentId) ?? [];
}

export function getDocumentAgentAccessForSubject(
  context: PermissionBuildContext,
  subjectId: string,
): ReturnType<typeof listDocumentAgentAccessSync> {
  return context.documentAgentAccessBySubjectId.get(normalizeKey(subjectId)) ?? [];
}

export function getDocumentPermissionRequestsForDocument(
  context: PermissionBuildContext,
  documentId: string,
): ReturnType<typeof listDocumentPermissionRequestsSync> {
  return context.documentPermissionRequestsByDocumentId.get(documentId) ?? [];
}

export function getDocumentPermissionRequestsForAgent(
  context: PermissionBuildContext,
  employeeName: string,
): ReturnType<typeof listDocumentPermissionRequestsSync> {
  return context.documentPermissionRequestsByAgentName.get(normalizeKey(employeeName)) ?? [];
}

export function getAgentForkInvitationsForSource(
  context: PermissionBuildContext,
  employeeName: string,
): ReturnType<typeof listAgentForkInvitationsSync> {
  return context.agentForkInvitationsBySourceName.get(normalizeKey(employeeName)) ?? [];
}

export function getAgentAccessRequestsForSource(
  context: PermissionBuildContext,
  employeeName: string,
): ReturnType<typeof listAgentAccessRequestsSync> {
  return context.agentAccessRequestsBySourceName.get(normalizeKey(employeeName)) ?? [];
}
