import type { ReportTaskMessagesRequest } from "@dofe-agent/domain";
import { appendReportedTaskMessages } from "../../../_lib/task-messages";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;
  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) return task;

  const body = (await request.json()) as Partial<ReportTaskMessagesRequest>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages[] is required." }, { status: 400 });
  }
  return Response.json({ messages: appendReportedTaskMessages(task, body.messages) });
}
