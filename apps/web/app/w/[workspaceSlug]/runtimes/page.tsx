import {
  listManagedRuntimesForWorkspaceSync,
  listManagedRuntimeTasksSync,
  resolveAgentRuntimeMode,
} from "@dofe-agent/services";
import { listDaemonSnapshotsSync } from "@dofe-agent/db";
import { notFound } from "next/navigation";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { RuntimesPageClient } from "@/features/runtimes/runtimes-page-client";

export const dynamic = "force-dynamic";

export default async function WorkspaceRuntimesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  if (resolveAgentRuntimeMode() !== "remote") {
    notFound();
  }
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const isAdmin = hasWorkspaceRole(workspaceContext.currentMembership.role, "admin");

  const tasks = isAdmin
    ? listManagedRuntimeTasksSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        actorUserId: workspaceContext.currentUser.id,
      })
    : [];
  const runtimes = isAdmin
    ? listManagedRuntimesForWorkspaceSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        actorUserId: workspaceContext.currentUser.id,
      })
    : [];
  const targetServers = isAdmin
    ? listDaemonSnapshotsSync(workspaceContext.currentWorkspace.id).map(({ daemon }) => ({
        deviceName: daemon.deviceName,
        status: daemon.status,
      }))
    : [];

  return (
    <RuntimesPageClient
      workspaceSlug={workspaceContext.currentWorkspace.slug}
      isAdmin={isAdmin}
      initialTasks={tasks}
      initialRuntimes={runtimes}
      targetServers={targetServers}
    />
  );
}
