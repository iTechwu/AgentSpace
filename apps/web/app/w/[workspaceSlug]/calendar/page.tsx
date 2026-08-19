import type { Metadata } from "next";
import { CalendarPageClient } from "@/features/calendar/calendar-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "定时任务",
  description: "以日历视角查看与管理定时和计划任务。",
};

export default async function WorkspaceCalendarPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "calendar", (data, workspaceContext) => (
    <CalendarPageClient data={data.data} workspaceSlug={workspaceContext.currentWorkspace.id} />
  ));
}
