import type { Metadata } from "next";
import { SkillsPageClient } from "@/features/skills/skills-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "技能库",
  description: "管理可安装到数字员工的技能包。",
};

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
