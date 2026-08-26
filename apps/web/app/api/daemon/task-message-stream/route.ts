import type { ReportTaskMessagesRequest } from "@dofe-agent/domain";
import { appendReportedTaskMessages } from "../_lib/task-messages";
import { readTaskForDaemon, requireDaemonAuth } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAME_LENGTH = 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_MESSAGES = 100_000;
const MAX_STREAM_DURATION_MS = 13 * 60 * 60 * 1_000;

export async function POST(request: Request): Promise<Response> {
  const taskId = new URL(request.url).searchParams.get("taskId")?.trim() ?? "";
  if (!taskId) {
    return Response.json({ error: "taskId is required." }, { status: 400 });
  }
  const initialTask = readWritableTask(request, taskId);
  if (initialTask instanceof Response) return initialTask;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-ndjson")) {
    return Response.json({ error: "Content-Type must be application/x-ndjson." }, { status: 415 });
  }
  if (!request.body) {
    return Response.json({ error: "Streaming request body is required." }, { status: 400 });
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let accepted = 0;
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_STREAM_BYTES) {
        return Response.json({ error: "Message stream exceeded its byte limit." }, { status: 413 });
      }
      if (Date.now() - startedAt > MAX_STREAM_DURATION_MS) {
        return Response.json({ error: "Message stream exceeded its duration limit." }, { status: 408 });
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_FRAME_LENGTH && !buffer.includes("\n")) {
        return Response.json({ error: "Message stream frame is too large." }, { status: 413 });
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        accepted += appendFrame(request, taskId, line);
        if (accepted > MAX_STREAM_MESSAGES) {
          return Response.json({ error: "Message stream exceeded its message limit." }, { status: 413 });
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) accepted += appendFrame(request, taskId, buffer);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  return Response.json({ accepted });
}

function appendFrame(request: Request, taskId: string, line: string): number {
  if (!line.trim()) return 0;
  if (line.length > MAX_FRAME_LENGTH) throw new Error("Message stream frame is too large.");
  const task = readWritableTask(request, taskId);
  if (task instanceof Response) {
    throw new Error(`Message stream is no longer authorized (${task.status}).`);
  }
  const frame = JSON.parse(line) as Partial<ReportTaskMessagesRequest> & { type?: string };
  if (frame.type === "ping") return 0;
  if (!Array.isArray(frame.messages) || frame.messages.length === 0) {
    throw new Error("Each message stream frame requires messages[].");
  }
  appendReportedTaskMessages(task, frame.messages);
  return frame.messages.length;
}

function readWritableTask(request: Request, taskId: string) {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) return task;
  if (task.status !== "running") {
    return Response.json({ error: "Task is not running." }, { status: 409 });
  }
  return task;
}
