import { resolveAgentRuntimeMode, runRuntimeMaintenanceAsync } from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }

  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ") || header.slice("Bearer ".length).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (resolveAgentRuntimeMode() !== "remote") {
    return Response.json({ ok: true, status: "skipped", reason: "remote_mode_required" });
  }

  const result = await runRuntimeMaintenanceAsync();
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
