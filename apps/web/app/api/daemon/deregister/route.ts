import { markDaemonOfflineSync } from "@dofe-agent/db";
import { readDaemonConnectionForDaemon, requireDaemonAuth } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const body = (await request.json()) as { daemonKey?: string; lastError?: string };
  if (!body.daemonKey?.trim()) {
    return Response.json({ error: "daemonKey is required." }, { status: 400 });
  }

  const daemon = readDaemonConnectionForDaemon(body.daemonKey.trim(), auth);
  if (daemon instanceof Response) {
    return daemon;
  }

  const snapshot = markDaemonOfflineSync(daemon.daemonKey, {
    lastError: typeof body.lastError === "string" ? body.lastError : undefined,
  });

  return Response.json({
    daemon: snapshot.daemon,
    runtimes: snapshot.runtimes,
  });
}
