"use server";

import {
  createDaemonApiTokenSync,
  deleteAgentRuntimeSync,
  pruneOfflineDaemonsSync,
  readAgentRuntimeSync,
  readEmployeeRuntimeBindingSync,
  requestAgentRuntimeProviderVerificationSync,
  updateWorkspaceRuntimeDisplayNameSync,
} from "@dofe-agent/db";
import type { AgentForkOptions } from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePath, revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  acceptAgentForkInvitationForActorSync,
  approveAgentAccessRequestForActorSync,
  assertAgentSkillRequirementsReadySync,
  bindEmployeeRuntimeSync,
  assertCanManageEmployeeForActorSync,
  assertCanUseEmployeeInChannelForActorSync,
  assertCanUseRuntimeForActorSync,
  cancelAgentAccessRequestForActorSync,
  createAgentAccessRequestForActorSync,
  createAgentForkInvitationForActorSync,
  createEmployeeSync,
  createTaskSync,
  deleteEmployeeSync,
  grantRuntimeUseToUserForActorSync,
  isWorkspaceAdminOrOwnerSync,
  hasGitHubSkillDependenciesSync,
  listEmployeeSkillIdsSync,
  queueGitHubSkillDependenciesForAgentSync,
  rejectAgentAccessRequestForActorSync,
  revokeAgentForkInvitationForActorSync,
  revokeRuntimeUseFromUserForActorSync,
  resolveSystemAgentTemplateForWorkspaceSync,
  setEmployeeChannelMemberAccessSync,
  setEmployeeKnowledgePageIdsSync,
  setEmployeeSkillIdsSync,
  tryRecordWorkspaceAuditEventSync,
  unbindEmployeeRuntimeSync,
  upsertAgentSkillRequirementsSync,
  updateEmployeeInstructionsSync,
} from "@dofe-agent/services";
import type { TaskRecord } from "@dofe-agent/domain/workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

const OLD_OFFLINE_DAEMON_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function createWorkspaceAgentAction(input: {
  name: string;
  remarkName?: string;
  summary?: string;
  instructions?: string;
  runtimeId?: string;
  templateId?: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  const actorUserId = workspaceContext.currentUser.id;
  const canManageWorkspaceAgents = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: actorUserId });
  const runtimeId = input.runtimeId?.trim() ?? "";
  const resolvedTemplate = input.templateId
    ? resolveSystemAgentTemplateForWorkspaceSync(input.templateId.trim(), workspaceId)
    : null;
  const template = resolvedTemplate?.template;
  const agentName = input.name.trim() || template?.defaultAgentName || "";
  assertRequired(agentName, "agent name");

  if (!canManageWorkspaceAgents && !runtimeId) {
    throw new Error("请先选择管理员分配给你的执行引擎。");
  }
  if (runtimeId) {
    assertCanUseRuntimeForActorSync({
      workspaceId,
      runtimeId,
      actorUserId,
    });
  }

  createEmployeeSync({
    name: agentName,
    role: template?.defaultTitle,
    remarkName: input.remarkName?.trim() || template?.defaultRemarkName || undefined,
    summary: input.summary?.trim() || template?.summary || undefined,
    instructions: input.instructions?.trim() || template?.instructions || undefined,
    origin: template ? `agent-template:${template.id}:v${template.version}` : undefined,
    fit: template?.fit,
    traits: template?.traits,
    skillIds: resolvedTemplate?.skillIds,
    ownerUserId: canManageWorkspaceAgents ? undefined : actorUserId,
    active: true,
  }, workspaceId);

  if (runtimeId) {
    bindEmployeeRuntimeSync(agentName, runtimeId, workspaceId);
  }

  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  const matchedSkillCount = resolvedTemplate?.skillIds.length ?? 0;
  return actionToastResult(
    undefined,
    template
      ? successToast(
          matchedSkillCount > 0 ? `Agent 已从模板创建，并绑定 ${matchedSkillCount} 个预置技能。` : "Agent 已从模板创建。",
          matchedSkillCount > 0 ? `Agent created from template with ${matchedSkillCount} preloaded skill(s).` : "Agent created from template.",
        )
      : successToast("Agent 已创建。", "Agent created."),
    buildAgentInvalidation(workspaceId, agentName),
  );
}

export async function createWorkspaceTaskAction(input: {
  title: string;
  channel: string;
  assignee: string;
  priority: TaskRecord["priority"];
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.title, "task title");
  assertRequired(input.channel, "channel");
  assertRequired(input.assignee, "assignee");
  assertCanUseEmployeeInChannelForActorSync({
    workspaceId,
    employeeName: input.assignee.trim(),
    channelName: input.channel.trim(),
    actorUserId: workspaceContext.currentUser.id,
    actorDisplayName: workspaceContext.currentUser.displayName,
    actorRole: workspaceContext.currentMembership.role,
  });

  const nextState = createTaskSync({
    title: input.title.trim(),
    channel: input.channel.trim(),
    assignee: input.assignee.trim(),
    priority: input.priority,
    requestedByUserId: workspaceContext.currentUser.id,
    requestedByDisplayName: workspaceContext.currentUser.displayName.trim() || undefined,
  }, workspaceId);

  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("任务已创建。", "Task created."),
    buildAgentTaskInvalidation(workspaceId, nextState.tasks[0]?.id, input.assignee.trim()),
  );
}

export async function bindWorkspaceAgentRuntimeAction(input: {
  employeeName: string;
  runtimeId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.runtimeId, "runtime id");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  assertCanUseRuntimeForActorSync({
    workspaceId,
    runtimeId: input.runtimeId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });

  const skillIds = listEmployeeSkillIdsSync(input.employeeName.trim(), workspaceId);
  const runtime = readAgentRuntimeSync(input.runtimeId.trim());
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
  assertAgentSkillRequirementsReadySync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    skillIds,
    runtimeProvider: runtime.provider,
  });
  const hasGitHubDependencies = hasGitHubSkillDependenciesSync({ workspaceId, skillIds });
  if (hasGitHubDependencies) {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
  }
  bindEmployeeRuntimeSync(input.employeeName.trim(), input.runtimeId.trim(), workspaceId);
  const dependencyQueue = hasGitHubDependencies
    ? queueGitHubSkillDependenciesForAgentSync({
      workspaceId,
      employeeName: input.employeeName.trim(),
      skillIds,
      actorUserId: workspaceContext.currentUser.id,
      actorDisplayName: workspaceContext.currentUser.displayName,
    })
    : { queued: 0, skipped: 0, waitingForRuntime: false };
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      dependencyQueue.queued > 0
        ? `执行引擎绑定已更新，${dependencyQueue.queued} 个受控依赖安装已排队。`
        : "执行引擎绑定已更新。",
      dependencyQueue.queued > 0
        ? `Execution-engine binding updated; ${dependencyQueue.queued} controlled dependency install(s) queued.`
        : "Execution-engine binding updated.",
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function unbindWorkspaceAgentRuntimeAction(employeeName: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  unbindEmployeeRuntimeSync(employeeName.trim(), workspaceId);
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("执行引擎绑定已解除。", "Execution-engine binding removed."),
    buildAgentInvalidation(workspaceId, employeeName.trim()),
  );
}

export async function verifyWorkspaceAgentRuntimeProviderAction(input: {
  employeeName: string;
  runtimeId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.runtimeId, "runtime id");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  assertCanUseRuntimeForActorSync({
    workspaceId,
    runtimeId: input.runtimeId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  requestAgentRuntimeProviderVerificationSync({
    workspaceId,
    runtimeId: input.runtimeId.trim(),
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      "Provider 验证已请求，在线执行引擎会在下一次心跳执行本机 CLI 预检。",
      "Provider verification requested. The online execution engine will run a local CLI preflight on its next heartbeat.",
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function deleteWorkspaceAgentAction(employeeName: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  deleteEmployeeSync(employeeName.trim(), workspaceId);
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("Agent 已删除。", "Agent deleted."),
    buildAgentInvalidation(workspaceId, employeeName.trim()),
  );
}

export async function updateWorkspaceAgentInstructionsAction(input: {
  employeeName: string;
  instructions: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  updateEmployeeInstructionsSync(input.employeeName.trim(), input.instructions, workspaceId);
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("Instructions 已保存。", "Instructions saved."),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function setWorkspaceAgentSkillAssignmentsAction(input: {
  employeeName: string;
  skillIds: string[];
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  const boundRuntime = readEmployeeRuntimeBindingSync(input.employeeName.trim(), workspaceId);
  assertAgentSkillRequirementsReadySync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    skillIds: input.skillIds,
    runtimeProvider: boundRuntime?.provider,
  });
  const hasGitHubDependencies = hasGitHubSkillDependenciesSync({
    workspaceId,
    skillIds: input.skillIds,
  });
  if (hasGitHubDependencies) {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
  }
  setEmployeeSkillIdsSync(input.employeeName.trim(), input.skillIds, workspaceId);
  const dependencyQueue = hasGitHubDependencies
    ? queueGitHubSkillDependenciesForAgentSync({
      workspaceId,
      employeeName: input.employeeName.trim(),
      skillIds: input.skillIds,
      actorUserId: workspaceContext.currentUser.id,
      actorDisplayName: workspaceContext.currentUser.displayName,
    })
    : { queued: 0, skipped: 0, waitingForRuntime: false };
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      dependencyQueue.queued > 0
        ? `Skills 绑定已保存，${dependencyQueue.queued} 个受控依赖安装已排队。`
        : dependencyQueue.waitingForRuntime
          ? "Skills 绑定已保存；将在 Agent 绑定并连接执行引擎后安装依赖。"
        : "Skills 绑定已保存。",
      dependencyQueue.queued > 0
        ? `Skill assignments saved; ${dependencyQueue.queued} controlled dependency install(s) queued.`
        : dependencyQueue.waitingForRuntime
          ? "Skill assignments saved; dependencies will install when the agent has an online runtime."
        : "Skill assignments saved.",
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function installWorkspaceAgentSkillAction(input: {
  employeeName: string;
  skillId: string;
  modelProvider?: string;
  modelId?: string;
  capabilities?: string[];
  projectWorkDir?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.skillId, "skill id");
  assertCanManageEmployeeForActorSync({ workspaceId, employeeName: input.employeeName.trim(), actorUserId: workspaceContext.currentUser.id });
  upsertAgentSkillRequirementsSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    skillId: input.skillId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    capabilities: input.capabilities,
    projectWorkDir: input.projectWorkDir,
    values: input.values,
    secrets: input.secrets,
  });
  const skillIds = [...new Set([...listEmployeeSkillIdsSync(input.employeeName.trim(), workspaceId), input.skillId.trim()])];
  const boundRuntime = readEmployeeRuntimeBindingSync(input.employeeName.trim(), workspaceId);
  assertAgentSkillRequirementsReadySync({ workspaceId, employeeName: input.employeeName.trim(), skillIds, runtimeProvider: boundRuntime?.provider });
  setEmployeeSkillIdsSync(input.employeeName.trim(), skillIds, workspaceId);
  const hasGitHubDependencies = hasGitHubSkillDependenciesSync({ workspaceId, skillIds });
  const dependencyQueue = hasGitHubDependencies
    ? queueGitHubSkillDependenciesForAgentSync({ workspaceId, employeeName: input.employeeName.trim(), skillIds, actorUserId: workspaceContext.currentUser.id, actorDisplayName: workspaceContext.currentUser.displayName })
    : { queued: 0, skipped: 0, waitingForRuntime: false };
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Agent skill configured",
    note: `${workspaceContext.currentUser.displayName} configured skill requirements for ${input.employeeName.trim()}.`,
    code: "workspace.agent_skill_requirements_configured",
    data: { actorType: "session_user", resourceType: "agent_skill_requirement", resourceId: `${input.employeeName.trim()}:${input.skillId.trim()}` },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast(
    dependencyQueue.queued > 0 ? `Skill 已安装并已排队安装 ${dependencyQueue.queued} 个依赖。` : "Skill 已为该 Agent 安装并完成配置。",
    dependencyQueue.queued > 0 ? `Skill installed; ${dependencyQueue.queued} dependency install(s) queued.` : "Skill installed and configured for this agent.",
  ), buildAgentInvalidation(workspaceId, input.employeeName.trim()));
}

export async function setWorkspaceAgentKnowledgeAssignmentsAction(input: {
  employeeName: string;
  knowledgePageIds: string[];
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  const actor = workspaceContext.currentUser.displayName.trim() || "system";
  setEmployeeKnowledgePageIdsSync(
    input.employeeName.trim(),
    input.knowledgePageIds,
    actor,
    workspaceId,
  );
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("知识绑定已保存。", "Knowledge assignments saved."),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function setWorkspaceAgentChannelMemberAccessAction(input: {
  employeeName: string;
  channelMemberAccess: "enabled" | "disabled";
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  setEmployeeChannelMemberAccessSync(
    input.employeeName.trim(),
    input.channelMemberAccess === "enabled" ? "enabled" : "disabled",
    workspaceId,
  );
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("群成员调用权限已保存。", "Channel member access saved."),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function createAgentForkInvitationAction(input: {
  sourceAgentName: string;
  targetUserId: string;
  options: AgentForkOptions;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.sourceAgentName, "source agent name");
  assertRequired(input.targetUserId, "target user id");
  createAgentForkInvitationForActorSync({
    workspaceId,
    sourceAgentName: input.sourceAgentName.trim(),
    targetUserId: input.targetUserId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    options: input.options,
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("Agent 复制邀请已发送。", "Agent copy invitation sent."));
}

export async function acceptAgentForkInvitationAction(input: {
  invitationId: string;
  newAgentName: string;
  runtimeId: string;
}): Promise<ActionToastResult<{ agentName: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.invitationId, "invitation id");
  assertRequired(input.newAgentName, "agent name");
  assertRequired(input.runtimeId, "runtime id");
  const result = acceptAgentForkInvitationForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    invitationId: input.invitationId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    newAgentName: input.newAgentName.trim(),
    runtimeId: input.runtimeId.trim(),
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    { agentName: result.agentName },
    successToast("Agent 副本已创建。", "Agent copy created."),
  );
}

export async function revokeAgentForkInvitationAction(input: {
  invitationId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.invitationId, "invitation id");
  revokeAgentForkInvitationForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    invitationId: input.invitationId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  revalidateWorkspacePath("/settings/permissions", workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("Agent 复制邀请已撤销。", "Agent copy invitation revoked."));
}

export async function createAgentAccessRequestAction(input: {
  sourceAgentName: string;
  requestType?: "fork_copy" | "channel_use";
  targetChannelName?: string;
  reason?: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.sourceAgentName, "source agent name");
  const requestType = input.requestType ?? "fork_copy";
  createAgentAccessRequestForActorSync({
    workspaceId,
    sourceAgentName: input.sourceAgentName.trim(),
    requesterUserId: workspaceContext.currentUser.id,
    requestType,
    targetChannelName: input.targetChannelName?.trim(),
    reason: input.reason?.trim(),
  });
  revalidateAgentAccessRequestRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    requestType === "channel_use"
      ? successToast("频道使用申请已发送。", "Channel use request sent.")
      : successToast("复制申请已发送。", "Copy request sent."),
    buildAgentAccessRequestInvalidation(workspaceId, input.sourceAgentName.trim()),
  );
}

export async function approveAgentAccessRequestAction(input: {
  requestId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.requestId, "request id");
  const request = approveAgentAccessRequestForActorSync({
    workspaceId,
    requestId: input.requestId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateAgentAccessRequestRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    request.requestType === "channel_use"
      ? successToast("已批准，频道调用权限已开放。", "Approved. Channel use is enabled.")
      : successToast("已批准，复制邀请已发送。", "Approved. The copy invitation was sent."),
    buildAgentAccessRequestInvalidation(workspaceId, request.sourceAgentName),
  );
}

export async function rejectAgentAccessRequestAction(input: {
  requestId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.requestId, "request id");
  const request = rejectAgentAccessRequestForActorSync({
    workspaceId,
    requestId: input.requestId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateAgentAccessRequestRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("已驳回申请。", "Request rejected."),
    buildAgentAccessRequestInvalidation(workspaceId, request.sourceAgentName),
  );
}

export async function cancelAgentAccessRequestAction(input: {
  requestId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.requestId, "request id");
  const request = cancelAgentAccessRequestForActorSync({
    workspaceId,
    requestId: input.requestId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateAgentAccessRequestRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("申请已取消。", "Request cancelled."),
    buildAgentAccessRequestInvalidation(workspaceId, request.sourceAgentName),
  );
}

export async function grantWorkspaceRuntimeUseAction(input: {
  runtimeId: string;
  userId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.runtimeId, "runtime id");
  assertRequired(input.userId, "user id");
  grantRuntimeUseToUserForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    userId: input.userId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("执行引擎已分配。", "Execution engine assigned."));
}

export async function revokeWorkspaceRuntimeUseAction(input: {
  runtimeId: string;
  userId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.runtimeId, "runtime id");
  assertRequired(input.userId, "user id");
  revokeRuntimeUseFromUserForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    userId: input.userId.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("执行引擎分配已移除。", "Execution engine assignment removed."));
}

export async function updateWorkspaceRuntimeDisplayNameAction(input: {
  runtimeId: string;
  displayName: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.runtimeId, "runtime id");
  if (input.displayName.trim().length > 80) {
    throw new Error("备注最多 80 个字符。");
  }

  const runtimeId = input.runtimeId.trim();
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceContext.currentWorkspace.id) {
    throw new Error("runtime.not_found");
  }

  updateWorkspaceRuntimeDisplayNameSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId,
    displayName: input.displayName,
    updatedByUserId: workspaceContext.currentUser.id,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Runtime display name updated",
    note: `${workspaceContext.currentUser.displayName} updated display name for runtime "${runtime.name}".`,
    code: "workspace.runtime_display_name_updated",
    data: {
      actorType: "session_user",
      resourceType: "runtime",
      resourceId: runtime.id,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("执行引擎备注已保存。", "Execution engine remark saved."));
}

export async function deleteWorkspaceRuntimeAction(runtimeIdInput: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(runtimeIdInput, "runtime id");

  const workspaceId = workspaceContext.currentWorkspace.id;
  const runtimeId = runtimeIdInput.trim();
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }

  const deleted = deleteAgentRuntimeSync({
    workspaceId,
    runtimeId,
  });
  if (!deleted) {
    throw new Error("runtime.not_found");
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Runtime deleted",
    note: `${workspaceContext.currentUser.displayName} deleted runtime "${runtime.name}".`,
    code: "workspace.runtime_deleted",
    data: {
      actorType: "session_user",
      resourceType: "runtime",
      resourceId: runtime.id,
      provider: runtime.provider,
    },
  });

  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("执行引擎已删除。", "Execution engine deleted."));
}

export async function createContainerInstallTokenAction(): Promise<{
  id: string;
  label: string;
  token: string;
}> {
  const workspaceContext = await requireCurrentWorkspaceContext();

  const createdBy = workspaceContext.currentUser.id;
  const label = `container-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const created = createDaemonApiTokenSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    label,
    createdBy,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Container install token created",
    note: `Container install token "${created.label}" was created by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.container_install_token_created",
    data: {
      actorType: "session_user",
      resourceType: "daemon_token",
      resourceId: created.id,
    },
  });

  revalidateWorkspacePath("/settings", workspaceContext.currentWorkspace.slug);

  return {
    id: created.id,
    label: created.label,
    token: created.token,
  };
}

export async function pruneOldOfflineDaemonsAction(): Promise<ActionToastResult<{
  removedCount: number;
}>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const removedCount = pruneOfflineDaemonsSync(OLD_OFFLINE_DAEMON_PRUNE_AGE_MS, {
    workspaceId: workspaceContext.currentWorkspace.id,
  });

  if (removedCount > 0) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: "Old daemon registrations pruned",
      note: `${workspaceContext.currentUser.displayName} pruned ${removedCount} daemon registration(s) without a heartbeat for more than 7 days.`,
      code: "workspace.daemon_registrations_pruned",
      data: {
        actorType: "session_user",
        resourceType: "daemon",
        resourceId: "offline-daemon-prune",
        removedCount,
      },
    });
  }

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/agents", "/settings"]);
  return actionToastResult(
    { removedCount },
    removedCount > 0
      ? successToast(`已清理 ${removedCount} 个旧 daemon。`, `${removedCount} old daemon registration(s) cleaned.`)
      : successToast("没有需要清理的旧 daemon。", "No old daemon registrations to clean."),
  );
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}

function revalidateWorkspaceRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/inbox", "/agents", "/im", "/market", "/skills", "/knowledge", "/task/board"]);
}

function revalidateAgentAccessRequestRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, [
    "/inbox",
    "/agents",
    "/approvals",
    "/settings/permissions",
    "/settings/permissions",
  ]);
}

function buildAgentInvalidation(workspaceId: string, agentName: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["agents", "inbox", "im", "market", "skills", "knowledge", "task-board"],
    resources: [{ type: "agent", id: agentName }],
    shell: "counters",
  };
}

function buildAgentAccessRequestInvalidation(workspaceId: string, agentName: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["agents", "inbox", "approvals", "settings"],
    resources: [
      { type: "agent", id: agentName },
      { type: "approval" },
    ],
    shell: "counters",
  };
}

function buildAgentTaskInvalidation(
  workspaceId: string,
  taskId: string | undefined,
  assignee: string,
): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["agents", "inbox", "task-board", "im"],
    resources: [
      taskId ? { type: "task", id: taskId } : { type: "task" },
      { type: "agent", id: assignee },
    ],
    shell: "counters",
  };
}
