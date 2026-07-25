import {
  DEFAULT_WORKSPACE_ID,
  canUserUseRuntimeSync,
  grantRuntimeUseToUserSync,
  listRuntimeGrantsForUserSync,
  listRuntimeGrantsSync,
  readAgentRuntimeSync,
  readEmployeeRuntimeBindingSync,
  readStoredEmployeeSync,
  readUserSync,
  readWorkspaceMembershipSync,
  revokeRuntimeUseFromUserSync,
  type WorkspaceRole,
  type WorkspaceRuntimeGrantRecord,
} from "@dofe-agent/db";
import { sameValue } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { canReadChannelForActorSync } from "../channel-access/channel-access.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { createNotificationSync } from "../notifications/notifications.ts";

export interface RuntimeAccessActor {
  userId?: string;
}

export function isWorkspaceAdminOrOwnerSync(input: {
  workspaceId?: string;
  userId?: string;
}): boolean {
  if (!input.userId) {
    return false;
  }
  const membership = readWorkspaceMembershipSync(input.workspaceId ?? DEFAULT_WORKSPACE_ID, input.userId);
  return membership?.role === "owner" || membership?.role === "admin";
}

export function canManageRuntimeGrantsSync(input: {
  workspaceId?: string;
  actorUserId?: string;
}): boolean {
  return isWorkspaceAdminOrOwnerSync({
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
  });
}

export function assertCanManageRuntimeGrantsSync(input: {
  workspaceId?: string;
  actorUserId?: string;
}): void {
  if (!canManageRuntimeGrantsSync(input)) {
    throw new Error("Only workspace owners and admins can manage runtime grants.");
  }
}

export function grantRuntimeUseToUserForActorSync(input: {
  workspaceId?: string;
  runtimeId: string;
  userId: string;
  actorUserId: string;
}): WorkspaceRuntimeGrantRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  assertCanManageRuntimeGrantsSync({
    workspaceId,
    actorUserId: input.actorUserId,
  });
  assertActiveWorkspaceMember(workspaceId, input.userId);
  const grant = grantRuntimeUseToUserSync({
    workspaceId,
    runtimeId: input.runtimeId,
    userId: input.userId,
    grantedByUserId: input.actorUserId,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Runtime grant created",
    note: `Runtime "${input.runtimeId.trim()}" was assigned to user "${input.userId.trim()}".`,
    code: "workspace.runtime_grant_created",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "runtime",
      resourceId: input.runtimeId.trim(),
      targetUserId: input.userId.trim(),
      permission: "use",
    },
  });
  const runtime = readAgentRuntimeSync(input.runtimeId.trim());
  const target = readUserSync(input.userId.trim());
  const actor = readUserSync(input.actorUserId.trim());
  createNotificationSync({
    workspaceId,
    recipientType: "human",
    recipientId: input.userId.trim(),
    actorType: "human",
    actorId: input.actorUserId.trim(),
    type: "runtime.use_granted",
    resourceType: "runtime",
    resourceId: input.runtimeId.trim(),
    title: "Runtime access granted",
    body: `${actor?.displayName ?? "A workspace manager"} granted ${target?.displayName ?? "you"} use access to ${runtime?.name ?? input.runtimeId.trim()}.`,
    actionHref: "/agents",
    severity: "success",
    dedupeKey: `runtime.use_granted:${workspaceId}:${input.runtimeId.trim()}:${input.userId.trim()}`,
    metadata: {
      runtimeName: runtime?.name,
      provider: runtime?.provider,
      targetUserId: input.userId.trim(),
      targetDisplayName: target?.displayName,
      actorUserId: input.actorUserId.trim(),
    },
  });
  return grant;
}

export function revokeRuntimeUseFromUserForActorSync(input: {
  workspaceId?: string;
  runtimeId: string;
  userId: string;
  actorUserId: string;
}): WorkspaceRuntimeGrantRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  assertCanManageRuntimeGrantsSync({
    workspaceId,
    actorUserId: input.actorUserId,
  });
  assertActiveWorkspaceMember(workspaceId, input.userId);
  const grant = revokeRuntimeUseFromUserSync({
    workspaceId,
    runtimeId: input.runtimeId,
    userId: input.userId,
  });
  if (grant) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId,
      title: "Runtime grant revoked",
      note: `Runtime "${input.runtimeId.trim()}" was removed from user "${input.userId.trim()}".`,
      code: "workspace.runtime_grant_revoked",
      data: {
        actorType: "session_user",
        actorUserId: input.actorUserId,
        resourceType: "runtime",
        resourceId: input.runtimeId.trim(),
        targetUserId: input.userId.trim(),
        permission: "use",
      },
    });
    const runtime = readAgentRuntimeSync(input.runtimeId.trim());
    const target = readUserSync(input.userId.trim());
    const actor = readUserSync(input.actorUserId.trim());
    createNotificationSync({
      workspaceId,
      recipientType: "human",
      recipientId: input.userId.trim(),
      actorType: "human",
      actorId: input.actorUserId.trim(),
      type: "runtime.use_revoked",
      resourceType: "runtime",
      resourceId: input.runtimeId.trim(),
      title: "Runtime access revoked",
      body: `${actor?.displayName ?? "A workspace manager"} removed ${target?.displayName ?? "your"} use access to ${runtime?.name ?? input.runtimeId.trim()}.`,
      actionHref: "/agents",
      severity: "warning",
      dedupeKey: `runtime.use_revoked:${workspaceId}:${input.runtimeId.trim()}:${input.userId.trim()}:${grant.updatedAt}`,
      metadata: {
        runtimeName: runtime?.name,
        provider: runtime?.provider,
        targetUserId: input.userId.trim(),
        targetDisplayName: target?.displayName,
        actorUserId: input.actorUserId.trim(),
      },
    });
  }
  return grant;
}

export function listRuntimeGrantsForActorSync(input: {
  workspaceId?: string;
  actorUserId?: string;
}): WorkspaceRuntimeGrantRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (canManageRuntimeGrantsSync({ workspaceId, actorUserId: input.actorUserId })) {
    return listRuntimeGrantsSync(workspaceId);
  }
  if (!input.actorUserId) {
    return [];
  }
  return listRuntimeGrantsForUserSync(workspaceId, input.actorUserId);
}

export function canUseRuntimeForActorSync(input: {
  workspaceId?: string;
  runtimeId: string;
  actorUserId?: string;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!runtimeBelongsToWorkspaceSync(workspaceId, input.runtimeId)) {
    return false;
  }
  if (isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId })) {
    return true;
  }
  if (!input.actorUserId) {
    return false;
  }
  return canUserUseRuntimeSync(workspaceId, input.runtimeId, input.actorUserId);
}

export function assertCanUseRuntimeForActorSync(input: {
  workspaceId?: string;
  runtimeId: string;
  actorUserId?: string;
}): void {
  if (!canUseRuntimeForActorSync(input)) {
    throw new Error("The selected runtime is not available to this user.");
  }
}

export function canManageEmployeeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId })) {
    return true;
  }
  if (!input.actorUserId) {
    return false;
  }
  const employee = readStoredEmployeeSync(input.employeeName, workspaceId);
  return employee?.ownerUserId === input.actorUserId;
}

export function assertCanManageEmployeeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): void {
  if (!canManageEmployeeForActorSync(input)) {
    throw new Error("This agent is not managed by the current user.");
  }
}

export function canUseEmployeeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): boolean {
  return canManageEmployeeForActorSync(input);
}

export function assertCanUseEmployeeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): void {
  if (!canUseEmployeeForActorSync(input)) {
    throw new Error("This agent is not available to the current user.");
  }
}

export function canUseEmployeeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (canUseEmployeeForActorSync({
    workspaceId,
    employeeName: input.employeeName,
    actorUserId: input.actorUserId,
  })) {
    return true;
  }
  return canUseChannelEnabledEmployeeInChannelForActorSync(input);
}

function canUseChannelEnabledEmployeeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!input.actorUserId) {
    return false;
  }

  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, input.employeeName));
  if (!employee) {
    return false;
  }
  if ((employee.channelMemberAccess ?? "enabled") !== "enabled") {
    return false;
  }
  if (!employee.channels.some((channelName) => sameValue(channelName, input.channelName))) {
    return false;
  }

  return canReadChannelForActorSync({
    workspaceId,
    channelName: input.channelName,
    actor: {
      userId: input.actorUserId,
      displayName: input.actorDisplayName,
      role: input.actorRole,
    },
  });
}

export function assertCanUseEmployeeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): void {
  if (!canUseEmployeeInChannelForActorSync(input)) {
    throw new Error("This agent is not available to the current user.");
  }
}

export function canUseEmployeeRuntimeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!canUseEmployeeForActorSync({ workspaceId, employeeName: input.employeeName, actorUserId: input.actorUserId })) {
    return false;
  }
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    return false;
  }
  return canUseRuntimeForActorSync({
    workspaceId,
    runtimeId: binding.runtimeId,
    actorUserId: input.actorUserId,
  });
}

export function assertCanUseEmployeeRuntimeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): void {
  if (!canUseEmployeeRuntimeForActorSync(input)) {
    throw new Error("This agent runtime is not available to the current user.");
  }
}

export function canUseEmployeeRuntimeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (canUseEmployeeRuntimeForActorSync({
    workspaceId,
    employeeName: input.employeeName,
    actorUserId: input.actorUserId,
  })) {
    return true;
  }
  if (!canUseChannelEnabledEmployeeInChannelForActorSync(input)) {
    return false;
  }
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    return false;
  }
  return runtimeBelongsToWorkspaceSync(workspaceId, binding.runtimeId);
}

export function assertCanUseEmployeeRuntimeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): void {
  if (!canUseEmployeeRuntimeInChannelForActorSync(input)) {
    throw new Error("This agent runtime is not available to the current user.");
  }
}

export function assertCanUseBoundEmployeeRuntimeForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  actorUserId?: string;
}): void {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    return;
  }
  assertCanUseRuntimeForActorSync({
    workspaceId,
    runtimeId: binding.runtimeId,
    actorUserId: input.actorUserId,
  });
}

export function assertCanUseBoundEmployeeRuntimeInChannelForActorSync(input: {
  workspaceId?: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorRole?: WorkspaceRole;
}): void {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    return;
  }
  if (canUseEmployeeRuntimeInChannelForActorSync(input)) {
    return;
  }
  throw new Error("This agent runtime is not available to the current user.");
}

function assertActiveWorkspaceMember(workspaceId: string, userId: string): void {
  if (!readWorkspaceMembershipSync(workspaceId, userId.trim())) {
    throw new Error("The target user is not an active member of this workspace.");
  }
}

function runtimeBelongsToWorkspaceSync(workspaceId: string, runtimeId: string): boolean {
  const runtime = readAgentRuntimeSync(runtimeId.trim());
  return runtime?.workspaceId === workspaceId;
}
