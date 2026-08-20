import { redirect } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { resolveStoredEmployeeIdSync } from "@dofe-agent/db";
import { createConversationForUserSync } from "@dofe-agent/services/conversations";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

/**
 * /w/[workspaceSlug]/new：多会话拆分稳定入口（docs/0820/session-split §2.1）。
 * 服务端先创建 Conversation，再重定向到带 conversation=<id> 的稳定地址。
 *
 * focus 解析：
 * - channel-<name> / channel:<name>  → 群聊会话（kind=group）
 * - contact-<employee> / contact:<employee> → 直接会话（kind=direct）
 *
 * 无法解析出员工/频道时重定向回 /im（会话选择点），不伪造本地历史、不回跳旧消息流。
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
  const channelName = focus.startsWith("channel-")
    ? focus.slice("channel-".length)
    : focus.startsWith("channel:")
      ? focus.slice("channel:".length)
      : "";
  const employeeName = focus.startsWith("contact-")
    ? focus.slice("contact-".length)
    : focus.startsWith("contact:")
      ? focus.slice("contact:".length)
      : "";

  // redirect() 通过抛异常工作，不能放进 try/catch，否则成功创建也会落入 catch 分支。
  let conversationId: string | null = null;
  try {
    if (channelName) {
      const result = createConversationForUserSync({
        workspaceId,
        channelName,
        createdByUserId: workspaceContext.currentUser.id,
        kind: "group",
      });
      conversationId = result.conversation.id;
    } else if (employeeName) {
      const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
      if (employeeId) {
        const result = createConversationForUserSync({
          workspaceId,
          employeeId,
          createdByUserId: workspaceContext.currentUser.id,
          kind: "direct",
        });
        conversationId = result.conversation.id;
      }
    }
  } catch {
    // 创建失败：回落 /im，不伪造本地历史（docs §2.2）。
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

  // 无法解析员工/频道（含创建失败）：回到会话选择点，不跳旧消息流、不强制 new=1。
  redirect(buildWorkspacePath(workspaceId, focus ? `/im?focus=${encodeURIComponent(focus)}` : "/im"));
}
