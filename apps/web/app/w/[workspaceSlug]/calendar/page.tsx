import { CalendarPageClient } from "@/features/calendar/calendar-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceCalendarPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "calendar", (data) => (
    <CalendarPageClient data={data.data} workspaceSlug={workspaceSlug} />
  ));
}
