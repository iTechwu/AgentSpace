// 频道域权限树节点构建：频道/访问申请/邀请节点与绑定。
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelRecord,
} from "@dofe-agent/domain/workspace";
import {
  resolveChannelHumanMemberNames,
} from "../channels/channels.ts";
import {
  sameValue,
} from "../shared/helpers.ts";
import {
  canReadDirectChannelForPermissionActor,
  getChannelAccessRequests,
  getChannelInvitations,
  getChannelParticipants,
} from "./permission-context.ts";
import type {
  PermissionBinding,
  PermissionBuildContext,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  buildWorkspaceManagerInheritedBindings,
  memberLabel,
  normalizeKey,
} from "./permission-utils.ts";

export function buildWorkspaceBindings(context: PermissionBuildContext): PermissionBinding[] {
  const members = Array.from(context.memberByUserId.values());
  const visibleMembers = context.isManager
    ? members
    : members.filter((member) => member.userId === context.actor.userId);

  return visibleMembers.map((member) => ({
    subjectType: "human",
    subjectId: member.userId,
    subjectLabel: memberLabel(member),
    permission: member.role,
    source: "workspace_role",
    status: "active",
    editable: false,
    metadata: {
      userId: member.userId,
      role: member.role,
      primaryEmail: member.primaryEmail,
    },
  }));
}

export function buildChannelNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const state = context.state;
  return context.visibleChannels.map((channel) => {
    const isDirectChannel = channel.kind === "direct";
    const managerPermission = isDirectChannel
      ? "manage membership; content private to direct participants"
      : "read/manage";
    const managerBindings = context.isManager
      ? buildWorkspaceManagerInheritedBindings(context, managerPermission)
      : [];
    const directReadBinding = context.isManager && isDirectChannel && canReadDirectChannelForPermissionActor(context, channel)
      ? [{
          subjectType: "human" as const,
          subjectId: context.actor.userId,
          subjectLabel: memberLabel(context.actor),
          permission: "direct content reader",
          source: "channel_participant" as const,
          status: "active" as const,
          editable: false,
          metadata: {
            channelName: channel.name,
            privacy: "direct_participant",
          },
        }]
      : [];
    const participants = getChannelParticipants(context, channel.name)
      .filter((participant) => context.isManager || participant.status === "active");
    const participantBindings = participants
      .flatMap((participant): PermissionBinding[] => {
        const member = context.memberByUserId.get(participant.userId);
        if (!member) {
          return [];
        }
        if (!context.isManager && member.userId !== context.actor.userId) {
          return [];
        }
        return [{
          subjectType: "human",
          subjectId: member.userId,
          subjectLabel: memberLabel(member),
          permission: "channel member",
          source: "channel_participant",
          status: participant.status === "active" ? "active" : "revoked",
          editable: context.isManager && participant.status === "active",
          revokeAction: context.isManager && participant.status === "active" ? "channel_participant_remove" : undefined,
          lastChangedAt: participant.updatedAt,
          metadata: {
            channelName: channel.name,
            userId: member.userId,
            participantId: participant.id,
            status: participant.status,
          },
        }];
      });
    const hasStructuredParticipants = getChannelParticipants(context, channel.name).length > 0;
    const legacyBindings: PermissionBinding[] = hasStructuredParticipants
      ? []
      : resolveChannelHumanMemberNames(state, channel)
          .map((displayName) => context.memberByDisplayName.get(normalizeKey(displayName)) ?? {
            userId: `human:${displayName}`,
            displayName,
            role: "member" as WorkspaceRole,
          })
          .filter((member) => context.isManager || member.userId === context.actor.userId)
          .map((member) => ({
            subjectType: "human" as const,
            subjectId: member.userId,
            subjectLabel: memberLabel(member),
            permission: "legacy channel member",
            source: "derived" as const,
            status: "active" as const,
            editable: false,
            metadata: {
              channelName: channel.name,
            },
          }));
    const children = [
      ...buildChannelAccessRequestNodes(context, channel),
      ...buildChannelInvitationNodes(context, channel),
    ];

    return {
      id: `channel:${channel.name}`,
      parentId: context.workspaceNodeId,
      resourceType: "channel",
      label: channel.name,
      status: "active",
      source: "channel_participant",
      metadata: {
        channelName: channel.name,
        kind: channel.kind ?? "group",
        humanMembers: channel.humanMembers,
        agentCount: channel.employeeNames.length,
      },
      bindings: [
        ...managerBindings,
        ...directReadBinding,
        ...participantBindings,
        ...legacyBindings,
        ...buildChannelAgentBindings(context, channel),
      ],
      children,
    } satisfies PermissionTreeNode;
  });
}

function buildChannelAccessRequestNodes(
  context: PermissionBuildContext,
  channel: ChannelRecord,
): PermissionTreeNode[] {
  const requests = getChannelAccessRequests(context, channel.name)
    .filter((request) => context.isManager || request.userId === context.actor.userId);

  return requests.map((request) => {
    const member = context.memberByUserId.get(request.userId);
    return {
      id: `channel-access-request:${request.id}`,
      parentId: `channel:${channel.name}`,
      resourceType: "channel_access_request",
      label: `${member?.displayName ?? request.userId} -> ${channel.name}`,
      status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
      source: "direct_grant",
      metadata: {
        requestId: request.id,
        channelName: channel.name,
        userId: request.userId,
        status: request.status,
        requestedAt: request.requestedAt,
      },
      bindings: [
        {
          subjectType: "human",
          subjectId: request.userId,
          subjectLabel: member ? memberLabel(member) : request.userId,
          permission: "requested channel access",
          source: "direct_grant",
          status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
          editable: context.isManager && request.status === "pending",
          updateAction: context.isManager && request.status === "pending" ? "channel_access_request_approve" : undefined,
          revokeAction: context.isManager && request.status === "pending" ? "channel_access_request_reject" : undefined,
          lastChangedAt: request.resolvedAt ?? request.requestedAt,
          metadata: {
            requestId: request.id,
            channelName: channel.name,
            userId: request.userId,
            status: request.status,
          },
        },
      ],
    } satisfies PermissionTreeNode;
  });
}

function buildChannelInvitationNodes(
  context: PermissionBuildContext,
  channel: ChannelRecord,
): PermissionTreeNode[] {
  const currentEmail = context.memberByUserId.get(context.actor.userId)?.primaryEmail?.toLocaleLowerCase("en-US");
  const invitations = getChannelInvitations(context, channel.name)
    .filter((invitation) =>
      context.isManager ||
      invitation.inviteeUserId === context.actor.userId ||
      (currentEmail && invitation.inviteeEmail?.toLocaleLowerCase("en-US") === currentEmail),
    );

  return invitations.map((invitation) => {
    const member = invitation.inviteeUserId ? context.memberByUserId.get(invitation.inviteeUserId) : undefined;
    const subjectId = invitation.inviteeUserId ?? `email:${invitation.inviteeEmail ?? invitation.id}`;
    const subjectLabel = member ? memberLabel(member) : invitation.inviteeEmail ?? subjectId;
    return {
      id: `channel-invitation:${invitation.id}`,
      parentId: `channel:${channel.name}`,
      resourceType: "channel_invitation",
      label: `${subjectLabel} -> ${channel.name}`,
      status: invitation.status === "pending" ? "pending" : invitation.status === "revoked" ? "revoked" : "active",
      source: "direct_grant",
      metadata: {
        invitationId: invitation.id,
        channelName: channel.name,
        inviteeUserId: invitation.inviteeUserId ?? null,
        inviteeEmail: invitation.inviteeEmail ?? null,
        status: invitation.status,
        expiresAt: invitation.expiresAt ?? null,
      },
      bindings: [
        {
          subjectType: "human",
          subjectId,
          subjectLabel,
          permission: "invited channel member",
          source: "direct_grant",
          status: invitation.status === "pending" ? "pending" : invitation.status === "revoked" ? "revoked" : "active",
          editable: context.isManager && invitation.status === "pending",
          revokeAction: context.isManager && invitation.status === "pending" ? "channel_invitation_revoke" : undefined,
          lastChangedAt: invitation.respondedAt ?? invitation.createdAt,
          metadata: {
            invitationId: invitation.id,
            channelName: channel.name,
            inviteeUserId: invitation.inviteeUserId ?? null,
            inviteeEmail: invitation.inviteeEmail ?? null,
            status: invitation.status,
          },
        },
      ],
    } satisfies PermissionTreeNode;
  });
}

function buildChannelAgentBindings(
  context: PermissionBuildContext,
  channel: ChannelRecord,
): PermissionBinding[] {
  return channel.employeeNames
    .filter((employeeName) => context.visibleEmployees.some((employee) => sameValue(employee.name, employeeName)))
    .map((employeeName) => {
      const employee = context.visibleEmployees.find((item) => sameValue(item.name, employeeName));
      return {
        subjectType: "agent",
        subjectId: employeeName,
        subjectLabel: employee?.remarkName ?? employeeName,
        permission: "channel agent",
        source: "direct_grant",
        status: "active",
        editable: context.isManager,
        metadata: {
          channelName: channel.name,
          employeeName,
        },
      } satisfies PermissionBinding;
    });
}
