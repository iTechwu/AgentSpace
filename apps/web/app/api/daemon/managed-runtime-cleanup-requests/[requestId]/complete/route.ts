import { completeManagedRuntimeCleanupRequestSync } from "@dofe-agent/db";
import { requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { requestId } = await context.params;
  const body = (await request.json()) as { result?: Record<string, unknown> } | undefined;

  const completed = completeManagedRuntimeCleanupRequestSync(requestId, "succeeded", body?.result);
  if (!completed) {
    return Response.json({ error: "Cleanup request not found." }, { status: 404 });
  }

  return Response.json({ requestId, status: "succeeded" });
}
