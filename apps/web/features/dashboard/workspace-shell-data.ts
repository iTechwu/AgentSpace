import { cache } from "react";
import {
  DEFAULT_WORKSPACE_ID,
  listDaemonSnapshotsSync,
  listWorkspaceMemberUsersSync,
} from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ChannelRecord } from "@dofe-agent/domain/workspace";
import {
  countUnreadNotificationsSync,
  listWorkspaceSkillsSync,
  readWorkspaceStateSnapshotSync,
  resolveChannelHumanMemberCount,
} from "@dofe-agent/services";
import { getPendingApprovalCount } from "@/features/approvals/approval-queue-data";

const readWorkspaceStateCached = cache((workspaceId: string) => readWorkspaceStateSnapshotSync(workspaceId));
const listWorkspaceSkillsCached = cache((workspaceId: string) => listWorkspaceSkillsSync(workspaceId));
const listDaemonSnapshotsCached = cache((workspaceId: string) => listDaemonSnapshotsSync(workspaceId));
const listWorkspaceMemberUsersCached = cache((workspaceId: string) => listWorkspaceMemberUsersSync(workspaceId));

type WorkspaceMemberUser = ReturnType<typeof listWorkspaceMemberUsersSync>[number];

export interface WorkspaceShellData {
  organizationName: string;
  humanMembers: number;
  channelCount: number;
  messageCount: number;
  unreadNotificationCount: number;
  openTaskCount: number;
  pendingApprovalCount: number;
  localAgentCount: number;
  remoteAgentCount: number;
  skillCount: number;
  knowledgePageCount: number;
  channels: Array<{
    name: string;
    memberLabel: string;
  }>;
  channelMemberCandidates: Array<{
    id: string;
    label: string;
    kind: "human" | "agent";
    meta: string;
  }>;
  contactCount: number;
  humanContacts: Array<{
    id: string;
    name: string;
    subtitle: string;
  }>;
  agents: Array<{
    id: string;
    name: string;
    subtitle: string;
    status: "idle" | "busy" | "error";
  }>;
  directMessages: Array<{
    id: string;
    name: string;
    subtitle: string;
    status: "idle" | "busy" | "error";
  }>;
}

export interface WorkspaceShellStableData {
  organizationName: string;
  channels: WorkspaceShellData["channels"];
  channelMemberCandidates: WorkspaceShellData["channelMemberCandidates"];
  humanContacts: WorkspaceShellData["humanContacts"];
  agents: WorkspaceShellData["agents"];
  directMessages: WorkspaceShellData["directMessages"];
}

export interface WorkspaceShellCounterData {
  humanMembers: number;
  channelCount: number;
  messageCount: number;
  unreadNotificationCount: number;
  openTaskCount: number;
  pendingApprovalCount: number;
  localAgentCount: number;
  remoteAgentCount: number;
  skillCount: number;
  knowledgePageCount: number;
  contactCount: number;
  humanContactCount: number;
  agentCount: number;
  runtimeCount: number;
}

export function getWorkspaceShellData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[] },
): WorkspaceShellData {
  return readLoadtestWorkspaceShellCache(
    buildWorkspaceShellCacheKey("full", currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole, options),
    () => getWorkspaceShellDataUncached(currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole, options),
  );
}

function getWorkspaceShellDataUncached(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[] },
): WorkspaceShellData {
  const context = buildWorkspaceShellContext(workspaceId, currentUserId, currentMembershipRole, options);
  const stable = buildWorkspaceShellStableData(context, currentUserDisplayName, currentUserId);
  const counters = buildWorkspaceShellCounterData(context, currentUserDisplayName, currentUserId, currentMembershipRole);

  return {
    ...stable,
    humanMembers: counters.humanMembers,
    channelCount: counters.channelCount,
    messageCount: counters.messageCount,
    unreadNotificationCount: counters.unreadNotificationCount,
    openTaskCount: counters.openTaskCount,
    pendingApprovalCount: counters.pendingApprovalCount,
    localAgentCount: counters.localAgentCount,
    remoteAgentCount: counters.remoteAgentCount,
    skillCount: counters.skillCount,
    knowledgePageCount: counters.knowledgePageCount,
    contactCount: counters.contactCount,
  };
}

export function getWorkspaceShellStableData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[] },
): WorkspaceShellStableData {
  return readLoadtestWorkspaceShellCache(
    buildWorkspaceShellCacheKey("stable", currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole, options),
    () => buildWorkspaceShellStableData(
      buildWorkspaceShellContext(workspaceId, currentUserId, currentMembershipRole, options),
      currentUserDisplayName,
      currentUserId,
    ),
  );
}

export function getWorkspaceShellCounterData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[] },
): WorkspaceShellCounterData {
  return readLoadtestWorkspaceShellCache(
    buildWorkspaceShellCacheKey("counter", currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole, options),
    () => buildWorkspaceShellCounterData(
      buildWorkspaceShellContext(workspaceId, currentUserId, currentMembershipRole, options),
      currentUserDisplayName,
      currentUserId,
      currentMembershipRole,
    ),
  );
}

interface WorkspaceShellCacheEntry<TData> {
  expiresAt: number;
  value: TData;
}

const workspaceShellCache = new Map<string, WorkspaceShellCacheEntry<unknown>>();

function readLoadtestWorkspaceShellCache<TData>(key: string, load: () => TData): TData {
  const ttlMs = readLoadtestWorkspaceShellCacheTtlMs();
  if (ttlMs <= 0) {
    return load();
  }

  const now = Date.now();
  const cached = workspaceShellCache.get(key) as WorkspaceShellCacheEntry<TData> | undefined;
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = load();
  workspaceShellCache.set(key, {
    expiresAt: now + ttlMs,
    value,
  });
  return value;
}

function readLoadtestWorkspaceShellCacheTtlMs(): number {
  const configured = Number.parseInt(process.env.DOFE_AGENT_WORKSPACE_SHELL_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return process.env.LOADTEST_MODE === "local" ? 2_000 : 0;
}

function buildWorkspaceShellCacheKey(
  scope: string,
  currentUserDisplayName: string | undefined,
  workspaceId: string,
  currentUserId: string | undefined,
  currentMembershipRole: WorkspaceRole | undefined,
  options: { channelNames?: string[] } | undefined,
): string {
  return JSON.stringify([
    scope,
    workspaceId,
    currentUserId ?? "",
    currentMembershipRole ?? "",
    currentUserDisplayName ?? "",
    options?.channelNames ?? [],
  ]);
}

function buildWorkspaceShellContext(
  workspaceId: string,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[] },
) {
  const state = readWorkspaceStateCached(workspaceId);
  const channelScope = normalizeChannelScope(options?.channelNames);
  const channelScoped = channelScope !== null;
  const workspaceMemberUsers = channelScoped ? [] : listWorkspaceMemberUsersCached(workspaceId);
  const canSeeAllAgents = !currentUserId || isWorkspaceManagerRole(currentMembershipRole);
  const activeRuntimes = listDaemonSnapshotsCached(workspaceId).flatMap((snapshot) =>
    snapshot.runtimes
      .filter((runtime) => runtime.status === "online")
      .map((runtime) => ({
        id: runtime.id,
        name: runtime.name,
        provider: runtime.provider,
      })),
  );
  const visibleRuntimeRecords = channelScoped
    ? []
    : canSeeAllAgents
      ? activeRuntimes
      : [];
  const groupChannels = state.channels.filter((channel) => (
    !isDirectChannelRecord(channel)
    && (!channelScope || channelScope.has(channel.name))
  ));
  const visibleEmployees = channelScoped
    ? state.activeEmployees.filter((employee) =>
        groupChannels.some((channel) => channel.employeeNames.some((name) => sameText(name, employee.name))),
      )
    : canSeeAllAgents
    ? state.activeEmployees
    : state.activeEmployees.filter((employee) => employee.ownerUserId === currentUserId);
  const visibleEmployeeNames = new Set(visibleEmployees.map((employee) => employee.name));
  const ownedAgentNames = state.activeEmployees
    .filter((employee) => currentUserId && employee.ownerUserId === currentUserId)
    .map((employee) => employee.name);
  const visibleTasks = canSeeAllAgents
    ? state.tasks
    : state.tasks.filter((task) => visibleEmployeeNames.has(task.assignee));

  return {
    canSeeAllAgents,
    channelScoped,
    groupChannels,
    ownedAgentNames,
    state,
    visibleEmployees,
    visibleRuntimeRecords,
    visibleTasks,
    workspaceId,
    workspaceMemberUsers,
  };
}

type WorkspaceShellContext = ReturnType<typeof buildWorkspaceShellContext>;

function buildWorkspaceShellStableData(
  context: WorkspaceShellContext,
  currentUserDisplayName?: string,
  currentUserId?: string,
): WorkspaceShellStableData {
  const {
    groupChannels,
    state,
    visibleEmployees,
    visibleRuntimeRecords,
    workspaceMemberUsers,
  } = context;
  const humanContacts = workspaceMemberUsers
    .filter((member) => isVisibleHumanContact(member, currentUserDisplayName, currentUserId))
    .map((member) => ({
      id: member.userId,
      name: member.displayName,
      subtitle: member.primaryEmail ?? formatWorkspaceRoleLabel(member.role),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }));

  return {
    organizationName: state.organizationName,
    channels: groupChannels.map((channel) => ({
      name: channel.name,
      memberLabel: `${resolveChannelHumanMemberCount(state, channel)} humans / ${channel.employeeNames.length} agents`,
    })),
    channelMemberCandidates: [
      ...workspaceMemberUsers.map((member) => ({
        id: member.displayName,
        label: member.displayName,
        kind: "human" as const,
        meta: member.primaryEmail ?? formatWorkspaceRoleLabel(member.role),
      })),
      ...visibleEmployees.map((employee) => ({
        id: employee.name,
        label: employee.remarkName?.trim() || employee.name,
        kind: "agent" as const,
        meta: employee.name,
      })),
    ],
    humanContacts,
    agents: visibleEmployees
      .map((employee) => ({
        id: employee.name,
        name: employee.remarkName?.trim() || employee.name,
        subtitle: employee.name,
        status: "idle" as const,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" })),
    directMessages: visibleRuntimeRecords.map((runtime) => ({
      id: runtime.id,
      name: runtime.name,
      subtitle: formatDaemonProviderLabel(runtime.provider),
      status: "idle" as const,
    })),
  };
}

function buildWorkspaceShellCounterData(
  context: WorkspaceShellContext,
  currentUserDisplayName?: string,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): WorkspaceShellCounterData {
  const {
    channelScoped,
    groupChannels,
    ownedAgentNames,
    state,
    visibleEmployees,
    visibleRuntimeRecords,
    visibleTasks,
    workspaceId,
    workspaceMemberUsers,
  } = context;
  const humanContactCount = channelScoped
    ? 0
    : workspaceMemberUsers.filter((member) => isVisibleHumanContact(member, currentUserDisplayName, currentUserId)).length;

  return {
    humanMembers: channelScoped ? 0 : workspaceMemberUsers.length,
    channelCount: groupChannels.length,
    messageCount: groupChannels.length + (channelScoped ? 0 : visibleEmployees.length),
    unreadNotificationCount: channelScoped || !currentUserId
      ? 0
      : countUnreadNotificationsSync({
          workspaceId,
          recipientType: "human",
          recipientId: currentUserId,
        }) + ownedAgentNames.reduce((total, agentName) => total + countUnreadNotificationsSync({
          workspaceId,
          recipientType: "agent",
          recipientId: agentName,
        }), 0),
    openTaskCount: visibleTasks.filter((task) => task.status !== "done").length,
    pendingApprovalCount: channelScoped
      ? 0
      : getPendingApprovalCount(workspaceId, {
          userId: currentUserId,
          displayName: currentUserDisplayName,
          role: currentMembershipRole,
        }),
    localAgentCount: visibleEmployees.length,
    remoteAgentCount: visibleRuntimeRecords.length,
    skillCount: listWorkspaceSkillsCached(workspaceId).length,
    knowledgePageCount: state.knowledgePages.length,
    contactCount: channelScoped ? 0 : humanContactCount + visibleEmployees.length,
    humanContactCount,
    agentCount: visibleEmployees.length,
    runtimeCount: visibleRuntimeRecords.length,
  };
}

function isVisibleHumanContact(
  member: WorkspaceMemberUser,
  currentUserDisplayName?: string,
  currentUserId?: string,
): boolean {
  return currentUserId
    ? member.userId !== currentUserId
    : !currentUserDisplayName || !sameText(currentUserDisplayName, member.displayName);
}

function isWorkspaceManagerRole(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

function isDirectChannelRecord(channel: Pick<ChannelRecord, "kind">): boolean {
  return channel.kind === "direct";
}

function normalizeChannelScope(channelNames?: string[]): Set<string> | null {
  if (!channelNames) {
    return null;
  }
  const normalized = channelNames.map((name) => name.trim()).filter(Boolean);
  return new Set(normalized);
}

function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

function formatWorkspaceRoleLabel(role: WorkspaceRole): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "admin") {
    return "Admin";
  }
  return "Member";
}
