import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { decodeWorkflowRunCursor, getWorkflowRunsPageSync } from "@/features/workflows/workflow-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * 工作区运行历史游标分页（UIUX:运行历史分页）：中心页 SSR 下发首页 + nextCursor/hasMore，
 * 前端在「运行」标签通过此接口按 limit/cursor 续拉下一页。
 *
 * 游标取代 offset，消除「分页期间新增运行导致 offset 错位、漏记录或按钮永不结束」的缺陷。
 * cursor 为不透明 base64url 令牌（由 getWorkflowRunsPageSync 编码）；缺省返回首页。非法游标
 * 返回 400 而非静默回首页，避免分页错位被掩盖。鉴权与 /workflow-runs/[runId]/events 一致：
 * 必须是工作区成员且非 channel 受限范围。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (workspaceContext.accessScope === "channel") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit") ?? String(DEFAULT_PAGE_SIZE);
  if (!/^\d+$/.test(rawLimit)) {
    return NextResponse.json({ error: "Invalid pagination parameters." }, { status: 400 });
  }
  const limit = Math.min(Number(rawLimit), MAX_PAGE_SIZE);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return NextResponse.json({ error: "Invalid pagination parameters." }, { status: 400 });
  }
  const rawCursor = params.get("cursor");
  // 游标存在但无法解码 → 视为非法，返回 400（不静默回首页，避免错位被掩盖）。
  if (rawCursor !== null && decodeWorkflowRunCursor(rawCursor, workspaceId) === null) {
    return NextResponse.json({ error: "Invalid pagination parameters." }, { status: 400 });
  }

  try {
    const page = getWorkflowRunsPageSync(workspaceId, { limit, cursor: rawCursor });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof Error && error.message === "workflow_run_cursor_expired") {
      return NextResponse.json({ code: "workflow_run_cursor_expired" }, { status: 409 });
    }
    throw error;
  }
}
