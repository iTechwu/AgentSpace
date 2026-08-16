import { SkillsPageClient } from "@/features/skills/skills-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceSkillsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "skills", (data) => (
    <SkillsPageClient data={data.data} />
  ));
}
