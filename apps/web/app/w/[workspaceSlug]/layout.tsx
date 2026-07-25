import { notFound, redirect } from "next/navigation";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";
import { WorkspaceAccessScreen } from "@/features/auth/workspace-access-screen";
import { WorkspaceFrame } from "@/features/dashboard/workspace-frame";
import { getWorkspaceShellData } from "@/features/dashboard/workspace-shell-data";
import { normalizeWorkspaceSlugParam } from "./_lib/workspace-slug";

export const dynamic = "force-dynamic";

export default async function WorkspaceSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug: routeWorkspaceSlug } = await params;
  const workspaceSlug = normalizeWorkspaceSlugParam(routeWorkspaceSlug);
  const workspaceAccess = await getWorkspaceAccessForIdentifier(workspaceSlug);
  if (workspaceAccess.status === "unauthenticated") {
    redirect("/");
  }
  if (workspaceAccess.status === "not_found") {
    notFound();
  }
  if (workspaceAccess.status === "forbidden") {
    return (
      <WorkspaceAccessScreen
        availableWorkspaces={workspaceAccess.workspaces}
        workspaceSlug={workspaceSlug}
      />
    );
  }
  const workspaceContext = workspaceAccess.context;
  if (workspaceContext.currentWorkspace.slug !== workspaceSlug) {
    notFound();
  }

  return (
    <WorkspaceFrame
      currentMembershipRole={workspaceContext.currentMembership.role}
      accessScope={workspaceContext.accessScope}
      channelNames={workspaceContext.channelNames}
      currentWorkspace={workspaceContext.currentWorkspace}
      shell={getWorkspaceShellData(
        workspaceContext.currentUser.displayName,
        workspaceContext.currentWorkspace.id,
        workspaceContext.currentUser.id,
        workspaceContext.currentMembership.role,
        workspaceContext.accessScope === "channel"
          ? { channelNames: workspaceContext.channelNames ?? [] }
          : undefined,
      )}
      user={workspaceContext.currentUser}
      workspaces={workspaceContext.workspaces}
    >
      {children}
    </WorkspaceFrame>
  );
}
