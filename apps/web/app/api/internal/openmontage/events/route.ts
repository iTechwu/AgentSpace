import {
  dispatchOpenMontageProjectionNotificationSync,
  ingestSignedOpenMontageEventSync,
  OpenMontageEventAuthenticationError,
  OpenMontageEventValidationError,
} from "@dofe-agent/services";
import {
  OpenMontageEventConflictError,
  OpenMontageEventNonceReplayError,
  OpenMontageJobBindingError,
} from "@dofe-agent/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OPENMONTAGE_EVENT_SIGNING_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: { code: "OPENMONTAGE_EVENT_BRIDGE_NOT_CONFIGURED" } },
      { status: 503 },
    );
  }

  try {
    const result = ingestSignedOpenMontageEventSync({
      body: new Uint8Array(await request.arrayBuffer()),
      headers: request.headers,
      secret,
    });
    if (result.notification) {
      try {
        dispatchOpenMontageProjectionNotificationSync(result.notification);
      } catch {
        // The durable notification outbox remains pending for a later drain.
      }
    }
    return Response.json(
      {
        accepted: true,
        outcome: result.outcome,
        lastAppliedSequence: result.projection.lastAppliedSequence,
      },
      { status: result.outcome === "duplicate" ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof OpenMontageEventAuthenticationError) {
      return Response.json({ error: { code: "OPENMONTAGE_EVENT_UNAUTHORIZED" } }, { status: 401 });
    }
    if (error instanceof OpenMontageJobBindingError) {
      return Response.json({ error: { code: "OPENMONTAGE_JOB_BINDING_NOT_FOUND" } }, { status: 404 });
    }
    if (
      error instanceof OpenMontageEventConflictError
      || error instanceof OpenMontageEventNonceReplayError
    ) {
      return Response.json({ error: { code: "OPENMONTAGE_EVENT_CONFLICT" } }, { status: 409 });
    }
    if (error instanceof OpenMontageEventValidationError) {
      return Response.json({ error: { code: "OPENMONTAGE_EVENT_INVALID" } }, { status: 422 });
    }
    throw error;
  }
}
