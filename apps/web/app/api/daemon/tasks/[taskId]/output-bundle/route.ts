import { buildTaskExecutionEventContext, recordTaskExecutionEventSync } from "@dofe-agent/db";
import type { DaemonTaskOutputBundle } from "@dofe-agent/domain";
import { parseTaskPayload } from "dofe-agent-daemon";
import { postMessageSync } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import { materializeOutputBundleToStaging } from "../../../_lib/output-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await routeContext.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }
  if (!["claimed", "running"].includes(task.status)) {
    return Response.json({ task: { id: task.id, status: task.status }, ignored: true });
  }

  const body = (await request.json()) as Partial<DaemonTaskOutputBundle>;
  if (
    body.version !== 1
    || body.format !== "json-inline-v1"
    || !Array.isArray(body.files)
  ) {
    return Response.json({ error: "Output bundle version, format, and files[] are required." }, { status: 400 });
  }

  try {
    materializeOutputBundleToStaging(task.id, task.workspaceId, body as DaemonTaskOutputBundle);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  if (body.files.length > 0) {
    const eventContext = buildTaskExecutionEventContext(task);
    recordTaskExecutionEventSync({
      ...eventContext,
      type: "artifact_detected",
      title: "Output bundle uploaded",
      summary: `${body.files.length} runtime output file${body.files.length === 1 ? "" : "s"} received for collection.`,
      status: "running",
      data: {
        fileCount: body.files.length,
        filePaths: body.files.slice(0, 12).map((file) => file.path),
        triggerType: eventContext.triggerType,
      },
    });
  }
  const payload = parseTaskPayload(task);
  if (body.files.length > 0 && payload.channel) {
    postMessageSync({
      channel: payload.channel,
      speaker: "系统提示",
      role: "agent",
      summary: `任务 ${payload.title || task.id} 已生成 ${body.files.length} 个产物，正在回收。`,
    }, task.workspaceId);
  }
  return Response.json({ taskId: task.id, accepted: true }, { status: 202 });
}
