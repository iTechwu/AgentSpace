import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/features/auth/auth-screen";
import { buildSsoStartUrl, readPublicAppUrl } from "@/features/auth/public-app-url";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";

export const dynamic = "force-dynamic";

// 未登录首页即登录入口；标题沿用根 layout 的品牌默认值，这里只补登录场景的描述与关键词。
export const metadata: Metadata = {
  description:
    "登录 DoFe.AI，进入你的智能工作区：用一句话驱动数字员工执行任务、编排流程、协作交付。支持企业 SSO 统一登录。",
  keywords: ["DoFe.AI 登录", "智能工作区", "数字员工", "AI 执行引擎", "企业 SSO"],
};

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const workspaceContext = await getCurrentWorkspaceContext();
  if (workspaceContext) {
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.id, "/im"));
  }

  const authError = typeof resolvedSearchParams.authError === "string" ? resolvedSearchParams.authError : undefined;
  return (
    <AuthScreen
      ssoStartUrl={buildSsoStartUrl(readPublicAppUrl())}
      initialError={authError}
    />
  );
}
