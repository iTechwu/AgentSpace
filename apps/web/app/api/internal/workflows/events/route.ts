import { fireWorkflowEventSync } from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.slice("Bearer ".length).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const body = await request.json() as {
      workspaceId?: string;
      eventName?: string;
      eventId?: string;
      input?: Record<string, unknown>;
    };
    const result = fireWorkflowEventSync({
      workspaceId: body.workspaceId ?? "",
      eventName: body.eventName ?? "",
      eventId: body.eventId ?? "",
      input: body.input,
    });
    return Response.json({
      matched: result.matchedTriggerIds.length,
      created: result.createdRunIds.length,
      deduplicated: result.deduplicatedTriggerIds.length,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "workflow_event_invalid" || code === "workflow_event_payload_too_large") {
      return Response.json({ error: "Invalid workflow event." }, { status: 400 });
    }
    return Response.json({ error: "Workflow event was not accepted." }, { status: 500 });
  }
}
