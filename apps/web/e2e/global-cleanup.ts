import {
  hardDeleteWorkspaceSync,
  listAllWorkspacesSync,
  listWorkspaceSsoBindingsSync,
} from "../../../packages/db/src/index.ts";
import { isDisposableTestWorkspace } from "../features/auth/sso-workspace-maintenance";

export function cleanupE2eWorkspacesSync(
  env: Pick<NodeJS.ProcessEnv, "DOFE_AGENT_E2E"> = process.env,
): string[] {
  if (env.DOFE_AGENT_E2E !== "1") return [];

  const bindingWorkspaceIds = new Set(
    listWorkspaceSsoBindingsSync().map((binding) => binding.workspaceId),
  );
  const workspaceIds = listAllWorkspacesSync()
    .filter((workspace) => (
      isDisposableTestWorkspace(workspace, bindingWorkspaceIds.has(workspace.id))
    ))
    .map((workspace) => workspace.id)
    .sort((left, right) => left.localeCompare(right));

  for (const workspaceId of workspaceIds) {
    hardDeleteWorkspaceSync(workspaceId);
  }
  return workspaceIds;
}

export default async function globalCleanup(): Promise<void> {
  cleanupE2eWorkspacesSync();
}
