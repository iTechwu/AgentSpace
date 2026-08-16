// 3.4-8：收敛 34 个 page.tsx 中「四步样板」——
// getWorkspacePageContext → loadWorkspaceModuleDataWithMeta →
// WorkspaceInitialModuleData → *PageClient。
// 标准形态的模块页收敛为对本函数的一次调用；带 searchParams / 自定义
// loader options 的页面（im、settings、contacts、agents 等）保持原样。

import type { ReactNode } from "react";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import type { WorkspaceModuleLoaderData, WorkspaceModuleLoaderId } from "@/features/dashboard/workspace-module-loaders";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { getWorkspacePageContext } from "./workspace-page-context";
import type { WorkspacePageContext } from "./workspace-page-context";

export async function renderWorkspaceModule<TModuleId extends WorkspaceModuleLoaderId>(
  workspaceSlug: string,
  moduleId: TModuleId,
  render: (
    data: Extract<WorkspaceModuleLoaderData, { moduleId: TModuleId }>,
    workspaceContext: WorkspacePageContext,
  ) => ReactNode,
  options: {
    /** 以当前登录用户作为 viewer 参与模块数据装载（大多数个性化模块需要）。 */
    withViewer?: boolean;
    /** 允许 channel 访问范围的会话进入（默认重定向到 /im）。 */
    allowChannelScope?: boolean;
  } = {},
): Promise<ReactNode> {
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, {
    allowChannelScope: options.allowChannelScope,
  });
  const result = await loadWorkspaceModuleDataWithMeta(
    moduleId,
    workspaceContext.currentWorkspace.id,
    options.withViewer
      ? {
        id: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        email: workspaceContext.currentUser.email,
        role: workspaceContext.currentMembership.role,
      }
      : undefined,
  );
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      {render(result.data, workspaceContext)}
    </WorkspaceInitialModuleData>
  );
}
