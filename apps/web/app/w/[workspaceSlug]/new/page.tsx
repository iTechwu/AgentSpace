import { redirect } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { resolveStoredEmployeeIdSync } from "@dofe-agent/db";
import { createConversationForUserSync } from "@dofe-agent/services/conversations";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

/**
 * /w/[workspaceSlug]/new：多会话拆分稳定入口（docs/0820/session-split §2.1）。
 * 服务端先创建 Conversation，再重定向到带 conversation=<id> 的稳定地址；
 * 创建失败退回旧 new=1 流程，不离开当前会话、不伪造本地历史。
 */
export default async function NewConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceSlug } = await params;
  const resolved = await searchParams;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, { allowChannelScope: true });
  const workspaceId = workspaceContext.currentWorkspace.id;

  const focus = typeof resolved?.focus === "string" ? resolved.focus : "";
  // focus 可能是 contact-<employeeName>（直接会话）或 contact:<employeeName>（旧格式）。
  const employeeName = focus.startsWith("contact-")
    ? focus.slice("contact-".length)
    : focus.startsWith("contact:")
      ? focus.slice("contact:".length)
      : "";
  const employeeId = employeeName ? resolveStoredEmployeeIdSync(employeeName, workspaceId) : null;

  // redirect() 通过抛异常工作，不能放进 try/catch，否则成功创建也会落入 catch 分支。
  if (employeeId) {
    let conversationId: string | null = null;
    try {
      const result = createConversationForUserSync({
        workspaceId,
        employeeId,
        createdByUserId: workspaceContext.currentUser.id,
        kind: "direct",
      });
      conversationId = result.conversation.id;
    } catch {
      // 创建失败：退回 new=1 流程，保留旧会话上下文、不伪造本地历史。
      conversationId = null;
    }
    if (conversationId) {
      redirect(
        buildWorkspacePath(
          workspaceId,
          `/im?focus=${encodeURIComponent(focus)}&conversation=${conversationId}`,
        ),
      );
    }
  }

  redirect(buildWorkspacePath(workspaceId, "/im?new=1"));
}
