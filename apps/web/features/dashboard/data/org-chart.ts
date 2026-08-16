// dashboard 组织架构页（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { formatWorkspaceRoleLabel, listWorkspaceMemberUsersCached, sameText } from "../dashboard-view-builders";
import { DEFAULT_WORKSPACE_ID, countUsersSync } from "@dofe-agent/db";
import { resolveChannelHumanMemberNames } from "@dofe-agent/services";
import { listEmployeeRuntimeBindingsCached, readWorkspaceStateCached } from "./cached.ts";

export function readAuthenticatedUserCountSync(): number {
  return countUsersSync();
}

// ── Org Chart ──
export interface OrgChartNode {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: "human" | "agent";
  channels: string[];
  status: "online" | "offline";
}
export interface OrgChartPageData {
  humans: OrgChartNode[];
  agents: OrgChartNode[];
  channels: Array<{ name: string; agentNames: string[] }>;
  totalHumans: number;
  totalAgents: number;
}
export function getOrgChartPageData(workspaceId = DEFAULT_WORKSPACE_ID): OrgChartPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const workspaceMembers = listWorkspaceMemberUsersCached(workspaceId);
  const bindings = listEmployeeRuntimeBindingsCached(workspaceId);
  const boundNames = new Set(bindings.map((b) => b.employeeName));

  const humans: OrgChartNode[] = workspaceMembers.map((member) => ({
    id: member.userId,
    name: member.displayName,
    displayName: member.displayName,
    role: formatWorkspaceRoleLabel(member.role),
    type: "human" as const,
    channels: state.channels
      .filter((ch) => resolveChannelHumanMemberNames(state, ch).some((name) => sameText(name, member.displayName)))
      .map((ch) => ch.name),
    status: "online" as const,
  }));

  const agents: OrgChartNode[] = state.activeEmployees.map((e) => ({
    id: e.name,
    name: e.name,
    displayName: e.remarkName?.trim() || e.name,
    role: e.role,
    type: "agent" as const,
    channels: e.channels,
    status: boundNames.has(e.name) ? ("online" as const) : ("offline" as const),
  }));

  const channels = state.channels.map((ch) => ({
    name: ch.name,
    agentNames: ch.employeeNames,
  }));

  return {
    humans,
    agents,
    channels,
    totalHumans: humans.length,
    totalAgents: agents.length,
  };
}

// ── Costs ──
