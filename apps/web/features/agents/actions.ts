"use server";

import {
  createDaemonApiTokenSync,
  createProviderAccountSync,
  createRuntimeProvisionRequestSync,
  deleteAgentRuntimeSync,
  getDatabase,
  pruneOfflineDaemonsSync,
  readRuntimeProvisionRequestSync,
  readAgentRuntimeSync,
  readAgentRouterSessionSync,
  readStoredEmployeeSync,
  readEmployeeRuntimeBindingSync,
  requestAgentRuntimeProviderVerificationSync,
  setAgentRouterSessionModelOverrideSync,
  clearAgentRouterSessionModelOverrideSync,
  updateRuntimeProvisionRequestSync,
  withTransaction,
  updateWorkspaceRuntimeDisplayNameSync,
} from "@dofe-agent/db";
import type { AgentForkOptions } from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePath, revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  acceptAgentForkInvitationForActorSync,
  approveAgentAccessRequestForActorSync,
  assertAgentSkillRequirementsReadySync,
  assertRuntimeCanBindEmployeeSync,
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
  ensureManagedRuntimeModelAllowedAsync,
  grantRuntimeUseToUserForActorSync,
  getManagedRuntimeCredentialEnvKey,
  isWorkspaceAdminOrOwnerSync,
  hasGitHubSkillDependenciesSync,
  listEmployeeSkillIdsSync,
  readAgentSkillRequirementConfigurationSync,
  queueGitHubSkillDependenciesForAgentSync,
  rejectAgentAccessRequestForActorSync,
  requestSkillRequirementConfigurationSync,
  revokeAgentForkInvitationForActorSync,
  revokeRuntimeUseFromUserForActorSync,
  resolveAgentRuntimeMode,
  resolveSystemAgentTemplateForWorkspaceSync,
  readSkillRequirementDeclarations,
  readWorkspaceSkillSync,
  rotateAgentSkillRequirementSecretSync,
  setEmployeeChannelMemberAccessSync,
  setEmployeeKnowledgePageIdsSync,
  setAgentSkillAssignmentsWithRequirementsValidationSync,
  tryRecordWorkspaceAuditEventSync,
  unbindEmployeeRuntimeSync,
  upsertAgentSkillRequirementsSync,
  deleteAgentSkillRequirementKeySync,
  updateEmployeeDefaultModelSync,
  updateEmployeeExecutionPolicySync,
  updateEmployeeInstructionsSync,
} from "@dofe-agent/services";
import type { TaskRecord } from "@dofe-agent/domain/workspace";
import { isDaemonProvider, type DaemonProvider, type EmployeeExecutionPolicy } from "@dofe-agent/domain";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import {
  actionToastResult,
  errorToast,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

const OLD_OFFLINE_DAEMON_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function assertManualRuntimeManagementEnabled(): void {
  if (resolveAgentRuntimeMode() === "remote") {
    throw new Error("manual_runtime.remote_mode_required");
  }
}

export async function createProviderAccountAction(input: {
  provider: string;
  name: string;
  billingAccountId?: string;
  secretRef?: string;
  configRef?: string;
  allowedModels?: string[];
}): Promise<ActionToastResult<{ id: string }>> {
  assertManualRuntimeManagementEnabled();
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "admin");
  if (!isDaemonProvider(input.provider)) throw new Error("Unsupported provider.");
  const account = createProviderAccountSync({
    workspaceId: context.currentWorkspace.id,
    provider: input.provider,
    name: input.name,
    billingAccountId: input.billingAccountId,
    secretRef: input.secretRef,
    configRef: input.configRef,
    allowedModels: input.allowedModels,
    createdBy: context.currentUser.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: context.currentWorkspace.id,
    title: "Provider account created",
    note: `${context.currentUser.displayName} created provider account "${account.name}".`,
    code: "workspace.provider_account_created",
    data: { actorType: "session_user", resourceType: "provider_account", resourceId: account.id, provider: account.provider },
  });
  revalidateWorkspaceRoutes(context.currentWorkspace.slug);
  return actionToastResult({ id: account.id }, successToast("Provider 账户已创建。", "Provider account created."));
}

export async function requestRuntimeProvisionAction(input: {
  providerAccountId: string;
  provider: string;
  runtimeName: string;
  targetServer: string;
}): Promise<ActionToastResult<{ id: string }>> {
  assertManualRuntimeManagementEnabled();
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "admin");
  if (!isDaemonProvider(input.provider)) throw new Error("Unsupported provider.");
  const request = createRuntimeProvisionRequestSync({
    workspaceId: context.currentWorkspace.id,
    providerAccountId: input.providerAccountId,
    provider: input.provider as DaemonProvider,
    runtimeName: input.runtimeName,
    targetServer: input.targetServer,
    requestedBy: context.currentUser.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: context.currentWorkspace.id,
    title: "Runtime provisioning requested",
    note: `${context.currentUser.displayName} requested ${request.provider} runtime "${request.runtimeName}" on ${request.targetServer}.`,
    code: "workspace.runtime_provision_requested",
    data: { actorType: "session_user", resourceType: "runtime_provision_request", resourceId: request.id, providerAccountId: request.providerAccountId },
  });
  revalidateWorkspaceRoutes(context.currentWorkspace.slug);
  return actionToastResult({ id: request.id }, successToast("执行引擎供给请求已创建。", "Runtime provisioning request created."));
}

export async function approveRuntimeProvisionAction(requestId: string): Promise<ActionToastResult<{
  token: string;
  tokenId: string;
  providerAccountId: string;
  provider: DaemonProvider;
}>> {
  assertManualRuntimeManagementEnabled();
  const context = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(context, "admin");
  const { created, request } = withTransaction(getDatabase(), () => {
    const pendingRequest = readRuntimeProvisionRequestSync(requestId.trim(), context.currentWorkspace.id);
    if (!pendingRequest || pendingRequest.status !== "requested") throw new Error("Provision request is not pending.");
    const created = createDaemonApiTokenSync({
      workspaceId: context.currentWorkspace.id,
      label: `provision-${requestId.trim()}`,
      createdBy: context.currentUser.id,
    });
    const request = updateRuntimeProvisionRequestSync({
      id: requestId.trim(),
      workspaceId: context.currentWorkspace.id,
      status: "approved",
      expectedStatus: "requested",
      actorUserId: context.currentUser.id,
      daemonTokenId: created.id,
    });
    if (!request) throw new Error("Provision request is not pending.");
    return { created, request };
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: context.currentWorkspace.id,
    title: "Runtime provisioning approved",
    note: `${context.currentUser.displayName} approved runtime "${request.runtimeName}".`,
    code: "workspace.runtime_provision_approved",
    data: { actorType: "session_user", resourceType: "runtime_provision_request", resourceId: request.id, daemonTokenId: created.id },
  });
  revalidateWorkspaceRoutes(context.currentWorkspace.slug);
  return actionToastResult({ token: created.token, tokenId: created.id, providerAccountId: request.providerAccountId, provider: request.provider }, successToast("供给请求已批准，服务器令牌已创建。", "Provisioning request approved and server token created."));
}

export async function createWorkspaceAgentAction(input: {
  name: string;
  remarkName?: string;
  summary?: string;
  instructions?: string;
  runtimeId?: string;
  defaultModel?: string;
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

  if (!canManageWorkspaceAgents) {
    throw new Error("Only workspace owners and admins can manage AI employees.");
  }
  const skillIds = resolvedTemplate?.skillIds ?? [];
  if (runtimeId) {
    assertCanUseRuntimeForActorSync({
      workspaceId,
      runtimeId,
      actorUserId,
    });
    assertRuntimeCanBindEmployeeSync(runtimeId);
    const boundRuntime = readAgentRuntimeSync(runtimeId);
    if (!boundRuntime || boundRuntime.workspaceId !== workspaceId) {
      throw new Error("runtime.not_found");
    }
    assertAgentSkillRequirementsReadySync({
      workspaceId,
      employeeName: agentName,
      skillIds,
      runtimeProvider: boundRuntime.provider,
    });
    if (input.defaultModel?.trim() && boundRuntime.managedCredentialId) {
      await ensureManagedRuntimeModelAllowedAsync({
        workspaceId,
        actorUserId,
        runtimeId: boundRuntime.id,
        modelId: input.defaultModel.trim(),
      });
    }
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
    ownerUserId: undefined,
    defaultModel: input.defaultModel?.trim() || undefined,
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
          matchedSkillCount > 0 ? `AI员工 已从模板创建，并绑定 ${matchedSkillCount} 个预置技能。` : "AI员工 已从模板创建。",
          matchedSkillCount > 0 ? `AI employee created from template with ${matchedSkillCount} preloaded skill(s).` : "AI employee created from template.",
        )
      : successToast("AI员工 已创建。", "AI employee created."),
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
  const employee = readStoredEmployeeSync(input.employeeName.trim(), workspaceId);
  if (employee?.defaultModel && runtime.managedCredentialId) {
    await ensureManagedRuntimeModelAllowedAsync({
      workspaceId,
      actorUserId: workspaceContext.currentUser.id,
      runtimeId: runtime.id,
      modelId: employee.defaultModel,
    });
  }
  // Reverse-check: when binding a managed remote runtime, its credential env key
  // must not collide with a key already declared by an installed skill. Install
  // blocks this forward; bind must block it backward so an existing skill cannot
  // silently shadow the runtime credential.
  const managedRuntimeCredentialKey = resolveAgentRuntimeMode() === "remote"
    ? getManagedRuntimeCredentialEnvKey(runtime.provider)
    : undefined;
  if (managedRuntimeCredentialKey) {
    for (const skillId of skillIds) {
      const skill = readWorkspaceSkillSync(skillId, workspaceId);
      if (!skill) continue;
      const declarations = readSkillRequirementDeclarations(skill.configJson);
      const conflicts = declarations.some(
        (declaration) => (declaration.kind === "config" || declaration.kind === "secret")
          && declaration.value === managedRuntimeCredentialKey,
      );
      if (conflicts) {
        throw new Error(
          `${managedRuntimeCredentialKey} is reserved by the runtime being bound and conflicts with skill "${skill.name}". Remove the declaration from that skill or use a different key.`,
        );
      }
    }
  }
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
    successToast("AI员工 已删除。", "AI employee deleted."),
    buildAgentInvalidation(workspaceId, employeeName.trim()),
  );
}

export async function updateWorkspaceAgentDefaultModelAction(input: {
  employeeName: string;
  defaultModel?: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  const defaultModel = input.defaultModel?.trim() || undefined;
  const binding = defaultModel && resolveAgentRuntimeMode() === "remote"
    ? readEmployeeRuntimeBindingSync(input.employeeName.trim(), workspaceId)
    : null;
  if (binding && defaultModel) {
    const runtime = readAgentRuntimeSync(binding.runtimeId);
    if (runtime?.managedCredentialId) {
      await ensureManagedRuntimeModelAllowedAsync({
        workspaceId,
        actorUserId: workspaceContext.currentUser.id,
        runtimeId: runtime.id,
        modelId: defaultModel,
      });
    }
  }
  updateEmployeeDefaultModelSync(
    input.employeeName.trim(),
    defaultModel,
    workspaceId,
  );
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("AI员工默认模型已保存。", "AI employee default model saved."),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function updateWorkspaceAgentExecutionPolicyAction(input: {
  employeeName: string;
  executionPolicy?: EmployeeExecutionPolicy;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  const runtime = readEmployeeRuntimeBindingSync(input.employeeName.trim(), workspaceId);
  const provider = runtime ? readAgentRuntimeSync(runtime.runtimeId)?.provider : undefined;
  assertExecutionPolicyMatchesProvider(input.executionPolicy, provider);
  updateEmployeeExecutionPolicySync(input.employeeName.trim(), input.executionPolicy, workspaceId);
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("执行权限已保存。", "Execution permissions saved."),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

function assertExecutionPolicyMatchesProvider(
  policy: EmployeeExecutionPolicy | undefined,
  provider: DaemonProvider | undefined,
): void {
  if (!policy) return;
  if (
    policy.claudePermissionMode !== undefined &&
    policy.claudePermissionMode !== "manual" &&
    policy.claudePermissionMode !== "acceptEdits" &&
    policy.claudePermissionMode !== "plan" &&
    policy.claudePermissionMode !== "auto"
  ) {
    throw new Error("Invalid Claude Code permission mode.");
  }
  if (
    policy.codexApprovalPolicy !== undefined &&
    policy.codexApprovalPolicy !== "untrusted" &&
    policy.codexApprovalPolicy !== "on-request" &&
    policy.codexApprovalPolicy !== "never"
  ) {
    throw new Error("Invalid Codex approval policy.");
  }
  if (
    policy.codexSandboxMode !== undefined &&
    policy.codexSandboxMode !== "workspace-write" &&
    policy.codexSandboxMode !== "danger-full-access"
  ) {
    throw new Error("Invalid Codex sandbox mode.");
  }
  if (provider === "claude" && (policy.codexApprovalPolicy || policy.codexSandboxMode)) {
    throw new Error("Codex execution settings cannot be saved for a Claude Code runtime.");
  }
  if (provider === "codex" && policy.claudePermissionMode) {
    throw new Error("Claude Code execution settings cannot be saved for a Codex runtime.");
  }
  if (provider && provider !== "claude" && provider !== "codex") {
    throw new Error("Execution permission settings are only available for Claude Code and Codex runtimes.");
  }
  if (!provider) {
    throw new Error("Bind a Claude Code or Codex runtime before saving execution permissions.");
  }
}

export async function setSessionModelOverrideAction(input: {
  routerSessionId: string;
  modelId?: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.routerSessionId, "router session id");
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId, userId: workspaceContext.currentUser.id })) {
    throw new Error("Only workspace admins can set a session model override.");
  }

  const session = readAgentRouterSessionSync(input.routerSessionId.trim());
  if (!session || session.workspaceId !== workspaceId) {
    throw new Error("session.not_found");
  }

  if (input.modelId?.trim()) {
    setAgentRouterSessionModelOverrideSync({
      routerSessionId: session.id,
      modelOverride: input.modelId.trim(),
      source: "manual",
    });
  } else {
    clearAgentRouterSessionModelOverrideSync(session.id);
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: input.modelId?.trim() ? "Session model override set" : "Session model override cleared",
    note: `${workspaceContext.currentUser.displayName} ${input.modelId?.trim() ? `set session model to "${input.modelId.trim()}"` : "cleared the session model override"} for ${session.agentId}.`,
    code: input.modelId?.trim() ? "session.model_overridden" : "session.model_override_cleared",
    data: {
      actorType: "session_user",
      resourceType: "router_session",
      resourceId: session.id,
      agentId: session.agentId,
      modelId: input.modelId?.trim(),
    },
  });

  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      input.modelId?.trim() ? "会话模型覆盖已设置。" : "会话模型覆盖已清除。",
      input.modelId?.trim() ? "Session model override set." : "Session model override cleared.",
    ),
    buildAgentInvalidation(workspaceId, session.agentId),
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
  setAgentSkillAssignmentsWithRequirementsValidationSync({
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
          ? "Skills 绑定已保存；将在 AI员工 绑定并连接执行引擎后安装依赖。"
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
  sensitiveKeys?: string[];
  /** Admin-added extra env vars, scoped to this employee + skill (not declared). */
  extraKeys?: string[];
  /** Map of declared key -> source skill id to copy an existing configured value from. */
  reuseValues?: Record<string, string>;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.skillId, "skill id");
  assertCanManageEmployeeForActorSync({ workspaceId, employeeName: input.employeeName.trim(), actorUserId: workspaceContext.currentUser.id });
  const assignedSkillIds = listEmployeeSkillIdsSync(input.employeeName.trim(), workspaceId);
  const isAlreadyAssigned = assignedSkillIds.includes(input.skillId.trim());
  const boundRuntime = readEmployeeRuntimeBindingSync(input.employeeName.trim(), workspaceId);
  const priorConfiguredSecretKeys = new Set(
    readAgentSkillRequirementConfigurationSync({ workspaceId, employeeName: input.employeeName.trim(), skillId: input.skillId.trim() }).configuredSecretKeys,
  );
  const managedRuntimeCredentialKey = boundRuntime && resolveAgentRuntimeMode() === "remote"
    ? getManagedRuntimeCredentialEnvKey(boundRuntime.provider)
    : undefined;
  let skillIds: string[];
  try {
    skillIds = upsertAgentSkillRequirementsSync({
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
      sensitiveKeys: input.sensitiveKeys,
      extraKeys: input.extraKeys,
      reuseValues: input.reuseValues,
      ...(managedRuntimeCredentialKey ? { managedRuntimeCredentialKey } : {}),
      ...(boundRuntime?.provider ? { runtimeProvider: boundRuntime.provider } : {}),
      assignSkill: true,
    }) ?? [];
  } catch (error) {
    // Directed handling for the platform encryption-key-missing case: never let
    // a secret/sensitive value degrade to plaintext, and tell the admin exactly
    // what to do instead of surfacing a generic failure.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY") || message.includes("encryption key")) {
      return actionToastResult(undefined, errorToast(
        "平台加密密钥未配置，无法保存密钥或敏感变量。请联系管理员配置 DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY。",
        "Platform encryption key is not configured, so secrets/sensitive values cannot be saved. Ask an admin to configure DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY.",
      ));
    }
    throw error;
  }
  const hasGitHubDependencies = hasGitHubSkillDependenciesSync({ workspaceId, skillIds });
  const dependencyQueue = hasGitHubDependencies
    ? queueGitHubSkillDependenciesForAgentSync({ workspaceId, employeeName: input.employeeName.trim(), skillIds, actorUserId: workspaceContext.currentUser.id, actorDisplayName: workspaceContext.currentUser.displayName })
    : { queued: 0, skipped: 0, waitingForRuntime: false };
  // Key names + counts by source (never values) for the install/update audit.
  const sensitiveKeySet = new Set((input.sensitiveKeys ?? []).map((key) => key.trim()));
  const configKeysConfigured = Object.keys(input.values ?? {}).filter((key) => !sensitiveKeySet.has(key));
  const secretKeysConfigured = Object.entries(input.secrets ?? {})
    .filter(([, value]) => (value ?? "").trim().length > 0)
    .map(([key]) => key);
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: isAlreadyAssigned ? "AI employee skill configuration updated" : "AI employee skill configured",
    note: `${workspaceContext.currentUser.displayName} ${isAlreadyAssigned ? "updated" : "configured"} skill requirements for ${input.employeeName.trim()}.`,
    code: isAlreadyAssigned ? "workspace.agent_skill_requirements_updated" : "workspace.agent_skill_requirements_configured",
    data: {
      actorType: "session_user",
      resourceType: "agent_skill_requirement",
      resourceId: `${input.employeeName.trim()}:${input.skillId.trim()}`,
      configKeys: configKeysConfigured.join(","),
      configKeyCount: String(configKeysConfigured.length),
      secretKeys: secretKeysConfigured.join(","),
      secretKeyCount: String(secretKeysConfigured.length),
      sensitiveKeys: Array.from(sensitiveKeySet).join(","),
      sensitiveKeyCount: String(sensitiveKeySet.size),
    },
  });
  // Secret rotation gets its own audit trail (key names + count only; never values). A secret
  // is "rotated" when a new value is supplied for a key that was already configured.
  const rotatedSecretKeys = Object.entries(input.secrets ?? {})
    .map(([key, value]) => ({ key, value: (value ?? "").trim() }))
    .filter((entry) => entry.value.length > 0 && priorConfiguredSecretKeys.has(entry.key))
    .map((entry) => entry.key);
  if (rotatedSecretKeys.length > 0) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId,
      title: "AI employee skill secret rotated",
      note: `${workspaceContext.currentUser.displayName} rotated ${rotatedSecretKeys.length} secret(s) for ${input.employeeName.trim()}: ${rotatedSecretKeys.join(", ")}.`,
      code: "workspace.agent_skill_secret_rotated",
      data: {
        actorType: "session_user",
        resourceType: "agent_skill_requirement",
        resourceId: `${input.employeeName.trim()}:${input.skillId.trim()}`,
        secretKeys: rotatedSecretKeys.join(","),
        secretCount: String(rotatedSecretKeys.length),
      },
    });
  }
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  if (isAlreadyAssigned) {
    return actionToastResult(undefined, successToast(
      dependencyQueue.queued > 0 ? `Skill 配置已更新，并已排队安装 ${dependencyQueue.queued} 个依赖。` : "该 AI员工 的 Skill 配置已更新。",
      dependencyQueue.queued > 0 ? `Skill configuration updated; ${dependencyQueue.queued} dependency install(s) queued.` : "Skill configuration updated for this agent.",
    ), buildAgentInvalidation(workspaceId, input.employeeName.trim()));
  }
  return actionToastResult(undefined, successToast(
    dependencyQueue.queued > 0 ? `Skill 已安装并已排队安装 ${dependencyQueue.queued} 个依赖。` : "Skill 已为该 AI员工 安装并完成配置。",
    dependencyQueue.queued > 0 ? `Skill installed; ${dependencyQueue.queued} dependency install(s) queued.` : "Skill installed and configured for this agent.",
  ), buildAgentInvalidation(workspaceId, input.employeeName.trim()));
}

export async function removeWorkspaceAgentSkillKeyAction(input: {
  employeeName: string;
  skillId: string;
  key: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.key, "key");
  assertCanManageEmployeeForActorSync({ workspaceId, employeeName: input.employeeName.trim(), actorUserId: workspaceContext.currentUser.id });
  const removed = deleteAgentSkillRequirementKeySync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    skillId: input.skillId.trim(),
    key: input.key.trim(),
    actorUserId: workspaceContext.currentUser.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "AI employee skill variable removed",
    note: `${workspaceContext.currentUser.displayName} removed ${removed.kind} variable ${input.key.trim()}${removed.sensitive ? " (sensitive)" : ""} from ${input.employeeName.trim()}.`,
    code: "workspace.agent_skill_requirement_key_deleted",
    data: {
      actorType: "session_user",
      resourceType: "agent_skill_requirement",
      resourceId: `${input.employeeName.trim()}:${input.skillId.trim()}`,
      key: input.key.trim(),
      kind: removed.kind,
      sensitive: String(removed.sensitive),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      `已删除变量 ${input.key.trim()}。`,
      `Removed variable ${input.key.trim()}.`,
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function rotateWorkspaceAgentSkillSecretAction(input: {
  employeeName: string;
  skillId: string;
  key: string;
  value: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.key, "key");
  assertRequired(input.value, "value");
  assertCanManageEmployeeForActorSync({ workspaceId, employeeName: input.employeeName.trim(), actorUserId: workspaceContext.currentUser.id });
  try {
    rotateAgentSkillRequirementSecretSync({
      workspaceId,
      employeeName: input.employeeName.trim(),
      skillId: input.skillId.trim(),
      key: input.key.trim(),
      value: input.value.trim(),
      actorUserId: workspaceContext.currentUser.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY") || message.includes("encryption key")) {
      return actionToastResult(undefined, errorToast(
        "平台加密密钥未配置，无法保存密钥。请联系管理员配置 DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY。",
        "Platform encryption key is not configured, so the secret cannot be saved. Ask an admin to configure DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY.",
      ));
    }
    throw error;
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "AI employee skill secret rotated",
    note: `${workspaceContext.currentUser.displayName} rotated secret ${input.key.trim()} for ${input.employeeName.trim()}.`,
    code: "workspace.agent_skill_secret_rotated",
    data: {
      actorType: "session_user",
      resourceType: "agent_skill_requirement",
      resourceId: `${input.employeeName.trim()}:${input.skillId.trim()}`,
      key: input.key.trim(),
      secretCount: "1",
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      `已轮换密钥 ${input.key.trim()}。`,
      `Rotated secret ${input.key.trim()}.`,
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
}

export async function requestWorkspaceAgentSkillConfigurationAction(input: {
  employeeName: string;
  skillId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspaceId = workspaceContext.currentWorkspace.id;
  assertRequired(input.employeeName, "employee name");
  assertRequired(input.skillId, "skill id");
  if (isWorkspaceAdminOrOwnerSync({ workspaceId, userId: workspaceContext.currentUser.id })) {
    throw new Error("Workspace admins can configure skill requirements directly; no hand-off request is needed.");
  }
  const result = requestSkillRequirementConfigurationSync({
    workspaceId,
    employeeName: input.employeeName.trim(),
    skillId: input.skillId.trim(),
    requesterUserId: workspaceContext.currentUser.id,
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast(
      result.adminCount > 0
        ? `已向 ${result.adminCount} 位管理员提交配置请求。`
        : "已记录配置请求，待管理员处理。",
      result.adminCount > 0
        ? `Configuration request sent to ${result.adminCount} admin(s).`
        : "Configuration request recorded for admins.",
    ),
    buildAgentInvalidation(workspaceId, input.employeeName.trim()),
  );
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
  return actionToastResult(undefined, successToast("AI员工 复制邀请已发送。", "AI employee copy invitation sent."));
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
    successToast("AI员工 副本已创建。", "AI employee copy created."),
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
  return actionToastResult(undefined, successToast("AI员工 复制邀请已撤销。", "AI employee copy invitation revoked."));
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
  assertManualRuntimeManagementEnabled();
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
