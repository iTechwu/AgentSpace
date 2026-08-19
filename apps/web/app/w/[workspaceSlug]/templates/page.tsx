import type { Metadata } from "next";
import { TemplatesPageClient } from "@/features/templates/templates-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "模板库",
  description: "浏览和使用预置的工作区模板。",
};

export default async function WorkspaceTemplatesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "templates", (data) => (
    <TemplatesPageClient data={data.data} />
  ));
}
