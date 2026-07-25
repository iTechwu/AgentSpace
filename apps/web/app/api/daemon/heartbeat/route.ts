import { heartbeatDaemonSync } from "@dofe-agent/db";
import type { HeartbeatDaemonRequest, HeartbeatDaemonResponse } from "@dofe-agent/domain";
import { readDaemonConnectionForDaemon, requireDaemonAuth } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const body = (await request.json()) as Partial<HeartbeatDaemonRequest>;
  if (!body.daemonKey?.trim()) {
    return Response.json({ error: "daemonKey is required." }, { status: 400 });
  }

  const daemon = readDaemonConnectionForDaemon(body.daemonKey.trim(), auth);
  if (daemon instanceof Response) {
    return daemon;
  }

  const snapshot = heartbeatDaemonSync(daemon.daemonKey, {
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    runtimes: Array.isArray(body.runtimes)
      ? body.runtimes
          .filter((runtime) => runtime && isRecord(runtime))
          .map((runtime) => ({
            id: typeof runtime.id === "string" ? runtime.id : undefined,
            provider: typeof runtime.provider === "string" ? runtime.provider : undefined,
            metadata: isRecord(runtime.metadata) ? runtime.metadata : undefined,
          }))
      : undefined,
  });
  const response: HeartbeatDaemonResponse = {
    daemon: {
      daemonKey: snapshot.daemon.daemonKey,
      status: snapshot.daemon.status,
      workspaceId: snapshot.daemon.workspaceId,
      lastHeartbeatAt: snapshot.daemon.lastHeartbeatAt,
    },
    runtimes: snapshot.runtimes.map((runtime) => ({
      id: runtime.id,
      provider: runtime.provider,
      status: runtime.status,
      lastHeartbeatAt: runtime.lastHeartbeatAt,
      metadata: safeParseRecord(runtime.metadataJson),
    })),
  };

  return Response.json(response);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
