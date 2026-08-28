import { recordSkillRunnerInvocationSync } from "@dofe-agent/db";
import type {
  ReportSkillRunnerInvocationsResponse,
  SkillRunnerInvocationReport,
} from "@dofe-agent/domain";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daemon-only: persists Skill Runner entrypoint invocation audits (docs/0803
 * P1-3). Only redacted fields are stored — raw runner output and secrets are
 * never transmitted. Records are idempotent per (workspace, eventId).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }

  let body: { invocations?: unknown };
  try {
    body = (await request.json()) as { invocations?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.invocations)) {
    return Response.json({ error: "invocations must be an array." }, { status: 400 });
  }
  if (body.invocations.length > 500) {
    return Response.json({ error: "Too many invocation records." }, { status: 400 });
  }

  const acceptedEventIds: string[] = [];
  let recorded = 0;
  for (const raw of body.invocations) {
    const invocation = raw as Partial<SkillRunnerInvocationReport> & Record<string, unknown>;
    if (
      typeof invocation.eventId !== "string"
      || typeof invocation.entrypoint !== "object"
      || invocation.entrypoint === null
    ) {
      continue;
    }
    const entrypoint = invocation.entrypoint as Partial<SkillRunnerInvocationReport["entrypoint"]>;
    if (
      typeof entrypoint.key !== "string"
      || typeof entrypoint.skillId !== "string"
      || typeof entrypoint.skillName !== "string"
      || typeof entrypoint.installationId !== "string"
      || typeof entrypoint.artifactDigest !== "string"
      || typeof entrypoint.id !== "string"
      || typeof entrypoint.path !== "string"
      || typeof entrypoint.runtime !== "string"
    ) {
      continue;
    }
    if (typeof invocation.exitCode !== "number" || typeof invocation.agentId !== "string") {
      continue;
    }

    recordSkillRunnerInvocationSync({
      // The daemon channel's authenticated workspace is authoritative.
      workspaceId: auth.workspaceId,
      taskId,
      runtimeId: typeof invocation.runtimeId === "string" ? invocation.runtimeId : undefined,
      skillId: entrypoint.skillId,
      skillName: entrypoint.skillName,
      artifactDigest: entrypoint.artifactDigest,
      entrypointId: entrypoint.id,
      entrypointKey: entrypoint.key,
      entrypointPath: entrypoint.path,
      entrypointRuntime: entrypoint.runtime,
      installationId: entrypoint.installationId,
      actorId: invocation.agentId,
      actorType: typeof invocation.actorType === "string" ? invocation.actorType : "agent",
      resultCode: Math.trunc(invocation.exitCode),
      timedOut: invocation.timedOut === true,
      durationMs: typeof invocation.durationMs === "number" ? invocation.durationMs : undefined,
      safeSummary: typeof invocation.safeSummary === "string" ? invocation.safeSummary : undefined,
      eventId: invocation.eventId,
    });
    acceptedEventIds.push(invocation.eventId);
    recorded += 1;
  }

  const response: ReportSkillRunnerInvocationsResponse = { recorded, acceptedEventIds };
  return Response.json(response);
}
