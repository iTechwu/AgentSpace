import { CalendarPageClient } from "@/features/calendar/calendar-page-client";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceCalendarPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const result = await loadWorkspaceModuleDataWithMeta("calendar", workspaceContext.currentWorkspace.id);
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      <CalendarPageClient data={result.data.data} workspaceSlug={workspaceSlug} />
    </WorkspaceInitialModuleData>
  );
}
