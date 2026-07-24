import { redirect } from "next/navigation";
import { AuthScreen } from "@/features/auth/auth-screen";
import { buildSsoStartUrl, readPublicAppUrl } from "@/features/auth/public-app-url";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const workspaceContext = await getCurrentWorkspaceContext();
  if (workspaceContext) {
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/im"));
  }

  const authError = typeof resolvedSearchParams.authError === "string" ? resolvedSearchParams.authError : undefined;
  return (
    <AuthScreen
      ssoStartUrl={buildSsoStartUrl(readPublicAppUrl())}
      initialError={authError}
    />
  );
}
