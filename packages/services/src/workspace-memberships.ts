import {
  listWorkspaceMembershipsPrismaCutover,
  type StoredWorkspaceMembershipRecord,
} from "@dofe-agent/db";

export function listWorkspaceMembershipsAsync(
  workspaceId: string,
): Promise<StoredWorkspaceMembershipRecord[]> {
  return listWorkspaceMembershipsPrismaCutover(workspaceId);
}
