import {
  drainPendingOpenMontageJobDelegationsAsync,
  reconcileSyncingOpenMontageJobsAsync,
} from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.slice(7).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const [events, delegations] = await Promise.all([
    reconcileSyncingOpenMontageJobsAsync({ limit: 50 }),
    drainPendingOpenMontageJobDelegationsAsync({ limit: 50 }),
  ]);
  return Response.json(
    { events, delegations },
    { status: events.failed > 0 || delegations.failed > 0 ? 503 : 200 },
  );
}
