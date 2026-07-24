import { listApprovalsSync } from "@agent-space/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string; approvalId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId, approvalId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }

  const approval = listApprovalsSync(auth.workspaceId).find((item) => item.id === approvalId);
  if (!approval || approval.sourceId !== task.id || approval.type !== "runtime_tool") {
    return Response.json({ error: `Runtime approval "${approvalId}" does not exist.` }, { status: 404 });
  }

  return Response.json({
    approval: {
      approvalId: approval.id,
      status: approval.status,
      reviewerComment: approval.reviewerComment,
    },
  });
}
