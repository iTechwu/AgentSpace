// 工作区成员与角色 helper：成员列表的 react cache 读取 + 角色判定/展示标签。
// 该模块会读 DB（listWorkspaceMemberUsersSync），不是纯函数模块。
import { cache } from "react";
import { listWorkspaceMemberUsersSync } from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";

export const listWorkspaceMemberUsersCached = cache((workspaceId: string) => listWorkspaceMemberUsersSync(workspaceId));

export function isWorkspaceManagerRole(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function formatWorkspaceRoleLabel(role: WorkspaceRole): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "admin") {
    return "Admin";
  }
  return "Member";
}
