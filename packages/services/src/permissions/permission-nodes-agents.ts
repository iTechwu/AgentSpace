// Agent 域权限树节点构建：Agent/fork 邀请/访问申请/技能/知识节点。
import {
  listEmployeeRuntimeBindingsSync,
} from "@dofe-agent/db";
import type {
  ActiveEmployee,
  WorkspaceSkill,
} from "@dofe-agent/domain/workspace";
import {
  listEmployeeSkillIdsMapSync,
} from "../employees/employees.ts";
import {
  listKnowledgeAssignmentPoliciesSync,
  listKnowledgeAssignmentsSync,
} from "../knowledge/assignments.ts";
import {
  canActorDecideAgentAccessRequest,
  canActorSeeAgentAccessRequest,
  getAgentAccessRequestsForSource,
  getAgentForkInvitationsForSource,
  getDocumentAgentAccessForSubject,
  getDocumentPermissionRequestsForAgent,
} from "./permission-context.ts";
import type {
  PermissionBinding,
  PermissionBuildContext,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  buildWorkspaceManagerInheritedBindings,
  describeAgentAccessRequestPermission,
  memberLabel,
  normalizeKey,
  parseAgentForkOrigin,
} from "./permission-utils.ts";

export function buildAgentNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const skillIdsByEmployee = listEmployeeSkillIdsMapSync(context.workspaceId);
  const knowledgePolicies = listKnowledgeAssignmentPoliciesSync(context.workspaceId);
  const selectedKnowledgeAssignments = listKnowledgeAssignmentsSync(context.workspaceId);
  const runtimeBindings = new Map(
    listEmployeeRuntimeBindingsSync(context.workspaceId).map((binding) => [binding.employeeName, binding]),
  );

  return context.visibleEmployees.map((employee) => {
    const owner = employee.ownerUserId ? context.memberByUserId.get(employee.ownerUserId) : undefined;
    const skillIds = skillIdsByEmployee.get(employee.name) ?? employee.skillIds;
    const runtimeBinding = runtimeBindings.get(employee.name);
    const forkedFrom = parseAgentForkOrigin(employee.origin);
    const selectedKnowledgePageIds = selectedKnowledgeAssignments
      .filter((assignment) => assignment.employeeName === employee.name)
      .map((assignment) => assignment.knowledgePageId);
    const allAgentKnowledgePageIds = knowledgePolicies
      .filter((policy) => policy.assignmentMode === "all_agents")
      .map((policy) => policy.knowledgePageId);
    const bindings: PermissionBinding[] = [];

    if (owner) {
      bindings.push({
        subjectType: "human",
        subjectId: owner.userId,
        subjectLabel: memberLabel(owner),
        permission: "agent owner",
        source: "agent_owner",
        status: "active",
        editable: false,
        metadata: {
          employeeName: employee.name,
          userId: owner.userId,
        },
      });
    } else if (context.isManager) {
      bindings.push(...buildWorkspaceManagerInheritedBindings(context, "manage/use"));
    }

    bindings.push({
      subjectType: "agent",
      subjectId: employee.name,
      subjectLabel: employee.remarkName ?? employee.name,
      permission: (employee.channelMemberAccess ?? "enabled") === "enabled" ? "channel members may use" : "owner/managers only",
      source: "agent_channel_member_access",
      status: "active",
      editable: context.isManager || employee.ownerUserId === context.actor.userId,
      updateAction: "agent_channel_member_access",
      metadata: {
        employeeName: employee.name,
        channelMemberAccess: employee.channelMemberAccess ?? "enabled",
      },
    });

    if (runtimeBinding) {
      bindings.push({
        subjectType: "agent",
        subjectId: employee.name,
        subjectLabel: employee.remarkName ?? employee.name,
        permission: `bound runtime: ${context.runtimeLabelById.get(runtimeBinding.runtimeId) ?? runtimeBinding.runtimeName}`,
        source: "direct_grant",
        status: "active",
        editable: context.isManager || employee.ownerUserId === context.actor.userId,
        updateAction: "agent_runtime_binding",
        revokeAction: "agent_runtime_unbind",
        lastChangedAt: runtimeBinding.updatedAt,
        metadata: {
          employeeName: employee.name,
          runtimeId: runtimeBinding.runtimeId,
        },
      });
    }

    if (forkedFrom) {
      const sourceAgent = context.visibleEmployees.find((item) => item.name === forkedFrom.sourceAgentName);
      bindings.push({
        subjectType: "agent",
        subjectId: forkedFrom.sourceAgentName,
        subjectLabel: sourceAgent?.remarkName ?? forkedFrom.sourceAgentName,
        permission: "fork source",
        source: "agent_fork",
        status: "inherited",
        editable: false,
        metadata: {
          employeeName: employee.name,
          sourceAgentName: forkedFrom.sourceAgentName,
          invitationId: forkedFrom.invitationId,
        },
      });
    }

    for (const access of getDocumentAgentAccessForSubject(context, employee.name)) {
      const document = context.state.channelDocuments.find((item) => item.id === access.documentId);
      bindings.push({
        subjectType: "agent",
        subjectId: employee.name,
        subjectLabel: employee.remarkName ?? employee.name,
        permission: `${access.role}: ${document?.title ?? access.documentId}`,
        source: "document_agent_access",
        status: access.revokedAt ? "revoked" : "active",
        editable: context.isManager && !access.revokedAt,
        revokeAction: context.isManager && !access.revokedAt ? "document_agent_access_revoke" : undefined,
        lastChangedAt: access.updatedAt,
        metadata: {
          grantId: access.id,
          employeeName: employee.name,
          documentId: access.documentId,
          documentTitle: document?.title ?? null,
          role: access.role,
        },
      });
    }

    for (const request of getDocumentPermissionRequestsForAgent(context, employee.name)) {
      const document = request.documentId
        ? context.state.channelDocuments.find((item) => item.id === request.documentId)
        : undefined;
      bindings.push({
        subjectType: "agent",
        subjectId: employee.name,
        subjectLabel: employee.remarkName ?? employee.name,
        permission: `requested ${request.requestedRole}: ${document?.title ?? request.externalUrl ?? request.externalFileId ?? request.id}`,
        source: "document_permission_request",
        status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
        editable: context.isManager && request.status === "pending",
        updateAction: context.isManager && request.status === "pending" ? "document_permission_request_approve" : undefined,
        revokeAction: context.isManager && request.status === "pending" ? "document_permission_request_reject" : undefined,
        lastChangedAt: request.decidedAt ?? request.createdAt,
        metadata: {
          requestId: request.id,
          employeeName: employee.name,
          documentId: request.documentId ?? null,
          externalFileId: request.externalFileId ?? null,
          externalUrl: request.externalUrl ?? null,
          role: request.requestedRole,
          status: request.status,
          reason: request.reason,
        },
      });
    }

    for (const request of getAgentAccessRequestsForSource(context, employee.name)) {
      if (!canActorSeeAgentAccessRequest(context, request, employee)) {
        continue;
      }
      const requester = context.memberByUserId.get(request.requesterUserId);
      const canDecide = canActorDecideAgentAccessRequest(context, request, employee);
      bindings.push({
        subjectType: "human",
        subjectId: request.requesterUserId,
        subjectLabel: requester ? memberLabel(requester) : request.requesterUserId,
        permission: describeAgentAccessRequestPermission(request),
        source: "agent_access_request",
        status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
        editable: canDecide && request.status === "pending",
        updateAction: canDecide && request.status === "pending" ? "agent_access_request_approve" : undefined,
        revokeAction: canDecide && request.status === "pending" ? "agent_access_request_reject" : undefined,
        lastChangedAt: request.resolvedAt ?? request.updatedAt,
        metadata: {
          requestId: request.id,
          employeeName: employee.name,
          sourceAgentName: request.sourceAgentName,
          requesterUserId: request.requesterUserId,
          requestType: request.requestType,
          targetChannelName: request.targetChannelName ?? null,
          status: request.status,
          reason: request.reason,
          forkInvitationId: request.forkInvitationId ?? null,
        },
      });
    }

    return {
      id: `agent:${employee.name}`,
      parentId: context.workspaceNodeId,
      resourceType: "agent",
      label: employee.remarkName ?? employee.name,
      status: "active",
      source: "agent_owner",
      bindings,
      metadata: {
        employeeName: employee.name,
        ownerUserId: employee.ownerUserId ?? null,
        channelMemberAccess: employee.channelMemberAccess ?? "enabled",
        forkSourceAgentName: forkedFrom?.sourceAgentName ?? null,
        forkInvitationId: forkedFrom?.invitationId ?? null,
        channelNames: employee.channels,
        assignedSkillIds: skillIds,
        selectedKnowledgePageIds,
        allAgentKnowledgePageIds,
      },
      children: [
        ...buildAgentAccessRequestChildNodes(context, employee),
        ...buildAgentForkInvitationNodes(context, employee),
        ...skillIds
          .map((skillId) => context.skillById.get(skillId))
          .filter((skill): skill is WorkspaceSkill => Boolean(skill))
          .map((skill) => buildSkillNode(context, employee, skill)),
        ...knowledgePolicies
          .filter((policy) => policy.assignmentMode === "all_agents" || selectedKnowledgePageIds.includes(policy.knowledgePageId))
          .map((policy) => buildKnowledgeNode(context, employee, policy.knowledgePageId, policy.assignmentMode)),
      ],
    } satisfies PermissionTreeNode;
  });
}

function buildAgentForkInvitationNodes(
  context: PermissionBuildContext,
  employee: ActiveEmployee,
): PermissionTreeNode[] {
  const sourceLabel = employee.remarkName ?? employee.name;
  return getAgentForkInvitationsForSource(context, employee.name)
    .filter((invitation) =>
      context.isManager ||
      employee.ownerUserId === context.actor.userId ||
      invitation.createdByUserId === context.actor.userId ||
      invitation.targetUserId === context.actor.userId,
    )
    .map((invitation) => {
      const target = context.memberByUserId.get(invitation.targetUserId);
      const creator = context.memberByUserId.get(invitation.createdByUserId);
      return {
        id: `agent-fork-invitation:${invitation.id}`,
        parentId: `agent:${employee.name}`,
        resourceType: "agent_fork_invitation",
        label: `${sourceLabel} -> ${target ? memberLabel(target) : invitation.targetUserId}`,
        status: "pending",
        source: "agent_fork",
        metadata: {
          invitationId: invitation.id,
          employeeName: employee.name,
          sourceAgentName: employee.name,
          targetUserId: invitation.targetUserId,
          createdByUserId: invitation.createdByUserId,
          status: invitation.status,
          createdAt: invitation.createdAt,
        },
        bindings: [
          {
            subjectType: "human",
            subjectId: invitation.targetUserId,
            subjectLabel: target ? memberLabel(target) : invitation.targetUserId,
            permission: `pending agent copy from ${sourceLabel}`,
            source: "agent_fork",
            status: "pending",
            editable: false,
            lastChangedAt: invitation.createdAt,
            metadata: {
              invitationId: invitation.id,
              employeeName: employee.name,
              sourceAgentName: employee.name,
              targetUserId: invitation.targetUserId,
              createdByUserId: invitation.createdByUserId,
              createdByLabel: creator ? memberLabel(creator) : invitation.createdByUserId,
            },
          },
        ],
      } satisfies PermissionTreeNode;
    });
}

function buildAgentAccessRequestChildNodes(
  context: PermissionBuildContext,
  employee: ActiveEmployee,
): PermissionTreeNode[] {
  const sourceLabel = employee.remarkName ?? employee.name;
  return getAgentAccessRequestsForSource(context, employee.name)
    .filter((request) => canActorSeeAgentAccessRequest(context, request, employee))
    .map((request) => {
      const requester = context.memberByUserId.get(request.requesterUserId);
      const resolver = request.resolverUserId ? context.memberByUserId.get(request.resolverUserId) : undefined;
      const canDecide = canActorDecideAgentAccessRequest(context, request, employee);
      return {
        id: `agent-access-request:${request.id}`,
        parentId: `agent:${employee.name}`,
        resourceType: "agent_access_request",
        label: `${requester ? memberLabel(requester) : request.requesterUserId} -> ${sourceLabel}`,
        status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
        source: "agent_access_request",
        metadata: {
          requestId: request.id,
          employeeName: employee.name,
          sourceAgentName: request.sourceAgentName,
          requesterUserId: request.requesterUserId,
          requestType: request.requestType,
          targetChannelName: request.targetChannelName ?? null,
          status: request.status,
          resolverUserId: request.resolverUserId ?? null,
          resolverLabel: resolver ? memberLabel(resolver) : null,
          forkInvitationId: request.forkInvitationId ?? null,
          reason: request.reason,
          createdAt: request.createdAt,
          resolvedAt: request.resolvedAt ?? null,
        },
        bindings: [
          {
            subjectType: "human",
            subjectId: request.requesterUserId,
            subjectLabel: requester ? memberLabel(requester) : request.requesterUserId,
            permission: describeAgentAccessRequestPermission(request, sourceLabel),
            source: "agent_access_request",
            status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
            editable: canDecide && request.status === "pending",
            updateAction: canDecide && request.status === "pending" ? "agent_access_request_approve" : undefined,
            revokeAction: canDecide && request.status === "pending" ? "agent_access_request_reject" : undefined,
            lastChangedAt: request.resolvedAt ?? request.updatedAt,
            metadata: {
              requestId: request.id,
              employeeName: employee.name,
              sourceAgentName: request.sourceAgentName,
              requesterUserId: request.requesterUserId,
              requestType: request.requestType,
              targetChannelName: request.targetChannelName ?? null,
              status: request.status,
              reason: request.reason,
              forkInvitationId: request.forkInvitationId ?? null,
            },
          },
        ],
      } satisfies PermissionTreeNode;
    });
}

export function buildAgentAccessRequestNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const visibleEmployeeNames = new Set(context.visibleEmployees.map((employee) => normalizeKey(employee.name)));
  return context.agentAccessRequests
    .filter((request) => !visibleEmployeeNames.has(normalizeKey(request.sourceAgentName)))
    .filter((request) => canActorSeeAgentAccessRequest(context, request))
    .map((request) => {
      const requester = context.memberByUserId.get(request.requesterUserId);
      const canDecide = canActorDecideAgentAccessRequest(context, request);
      return {
        id: `agent-access-request:${request.id}`,
        parentId: context.workspaceNodeId,
        resourceType: "agent_access_request",
        label: `${requester ? memberLabel(requester) : request.requesterUserId} -> ${request.sourceAgentName}`,
        status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
        source: "agent_access_request",
        metadata: {
          requestId: request.id,
          sourceAgentName: request.sourceAgentName,
          requesterUserId: request.requesterUserId,
          requestType: request.requestType,
          targetChannelName: request.targetChannelName ?? null,
          status: request.status,
          reason: request.reason,
          forkInvitationId: request.forkInvitationId ?? null,
        },
        bindings: [{
          subjectType: "human",
          subjectId: request.requesterUserId,
          subjectLabel: requester ? memberLabel(requester) : request.requesterUserId,
          permission: describeAgentAccessRequestPermission(request, request.sourceAgentName),
          source: "agent_access_request",
          status: request.status === "pending" ? "pending" : request.status === "approved" ? "active" : "revoked",
          editable: canDecide && request.status === "pending",
          updateAction: canDecide && request.status === "pending" ? "agent_access_request_approve" : undefined,
          revokeAction: canDecide && request.status === "pending" ? "agent_access_request_reject" : undefined,
          lastChangedAt: request.resolvedAt ?? request.updatedAt,
          metadata: {
            requestId: request.id,
            sourceAgentName: request.sourceAgentName,
            requesterUserId: request.requesterUserId,
            requestType: request.requestType,
            targetChannelName: request.targetChannelName ?? null,
            status: request.status,
            reason: request.reason,
            forkInvitationId: request.forkInvitationId ?? null,
          },
        }],
      } satisfies PermissionTreeNode;
    });
}

function buildSkillNode(
  context: PermissionBuildContext,
  employee: ActiveEmployee,
  skill: WorkspaceSkill,
): PermissionTreeNode {
  return {
    id: `agent:${employee.name}:skill:${skill.id}`,
    parentId: `agent:${employee.name}`,
    resourceType: "skill",
    label: skill.name,
    status: "active",
    source: "skill_assignment",
    metadata: {
      skillId: skill.id,
      employeeName: employee.name,
    },
    bindings: [
      {
        subjectType: "agent",
        subjectId: employee.name,
        subjectLabel: employee.remarkName ?? employee.name,
        permission: "can use skill",
        source: "skill_assignment",
        status: "active",
        editable: context.isManager || employee.ownerUserId === context.actor.userId,
        updateAction: "agent_skill_assignment",
        lastChangedAt: skill.updatedAt,
        metadata: {
          employeeName: employee.name,
          skillId: skill.id,
        },
      },
    ],
  };
}

function buildKnowledgeNode(
  context: PermissionBuildContext,
  employee: ActiveEmployee,
  knowledgePageId: string,
  assignmentMode: "all_agents" | "selected_agents",
): PermissionTreeNode {
  const page = context.state.knowledgePages.find((item) => item.id === knowledgePageId);
  return {
    id: `agent:${employee.name}:knowledge:${knowledgePageId}`,
    parentId: `agent:${employee.name}`,
    resourceType: "knowledge_page",
    label: page?.title ?? knowledgePageId,
    status: assignmentMode === "all_agents" ? "inherited" : "active",
    source: "knowledge_assignment",
    metadata: {
      employeeName: employee.name,
      knowledgePageId,
      assignmentMode,
    },
    bindings: [
      {
        subjectType: "agent",
        subjectId: employee.name,
        subjectLabel: employee.remarkName ?? employee.name,
        permission: assignmentMode === "all_agents" ? "inherits all-agent knowledge" : "can use knowledge page",
        source: "knowledge_assignment",
        status: assignmentMode === "all_agents" ? "inherited" : "active",
        editable: assignmentMode === "selected_agents" && (context.isManager || employee.ownerUserId === context.actor.userId),
        updateAction: assignmentMode === "selected_agents" ? "agent_knowledge_assignment" : undefined,
        lastChangedAt: page?.assignmentUpdatedAt ?? page?.updatedAt,
        metadata: {
          employeeName: employee.name,
          knowledgePageId,
          assignmentMode,
        },
      },
    ],
  };
}
