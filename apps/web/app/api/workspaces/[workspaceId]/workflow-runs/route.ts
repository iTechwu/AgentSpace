import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { getWorkflowRunsPageSync } from "@/features/workflows/workflow-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * 工作区运行历史分页（UIUX:运行历史分页）：中心页 SSR 只下发首页 50 条，前端在
 * 「运行」标签通过此接口按 limit/offset 加载更多，不再被硬限制为最近 50 条。
 *
 * 鉴权与 /workflow-runs/[runId]/events 一致：必须是工作区成员且非 channel 受限范围。
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
  const rawOffset = params.get("offset") ?? "0";
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) {
    return NextResponse.json({ error: "Invalid pagination parameters." }, { status: 400 });
  }
  const limit = Math.min(Number(rawLimit), MAX_PAGE_SIZE);
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Invalid pagination parameters." }, { status: 400 });
  }

  const page = getWorkflowRunsPageSync(workspaceId, { limit, offset });
  return NextResponse.json(page);
}
