import { defaultRuntimeMaintenanceDependencies } from "@dofe-agent/services/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs only the central Prisma cutover SLO flush and pager stages. Keeping this
 * separate from runtime provisioning lets local-mode maintenance workers emit
 * migration evidence without resuming managed-runtime provisioning.
 */
export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ") || header.slice("Bearer ".length).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const startedAt = new Date().toISOString();
  try {
    const flushed = await defaultRuntimeMaintenanceDependencies.flushSlo?.();
    const paged = await defaultRuntimeMaintenanceDependencies.pageSlo?.();
    return Response.json({ ok: true, startedAt, flushed, paged });
  } catch (error) {
    return Response.json({
      ok: false,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503 });
  }
}
