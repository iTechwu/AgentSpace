import {
  OpenMontageJobBindingError,
  readMcpTaskAuditAuthorizationSync,
} from "@dofe-agent/db";
import {
  bindOpenMontageJobDelegationAsync,
  OpenMontageDelegationConfigurationError,
  OpenMontageDelegationValidationError,
} from "@dofe-agent/services";
import {
  OPENMONTAGE_MCP_CATALOG_SLUG,
  parseOpenMontageSubmittedJob,
  type ClaimMcpTaskSessionResponse,
  type OpenMontageJobAttribution,
} from "@dofe-agent/domain";
import { readTaskForDaemon, requireDaemonAuth } from "../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) return task;
  if (task.status !== "running") {
    return Response.json({ error: "Task is no longer running." }, { status: 409 });
  }
  if (!task.runtimeCredentialId) {
    return Response.json(
      { error: "Task has no immutable Runtime credential attribution." },
      { status: 409 },
    );
  }

  let body: { connectionId?: unknown; snapshot?: unknown };
  try {
    body = (await request.json()) as { connectionId?: unknown; snapshot?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) {
    return Response.json({ error: "connectionId is required." }, { status: 400 });
  }

  const authorization = readMcpTaskAuditAuthorizationSync(taskId, auth.workspaceId);
  if (!authorization || authorization.expiresAt <= new Date().toISOString()) {
    return Response.json({ error: "MCP authorization snapshot is unavailable." }, { status: 422 });
  }
  let grant: ClaimMcpTaskSessionResponse;
  try {
    grant = JSON.parse(authorization.authorizationJson) as ClaimMcpTaskSessionResponse;
  } catch {
    return Response.json({ error: "MCP authorization snapshot is unreadable." }, { status: 422 });
  }
  const connection = grant.connections.find((candidate) => candidate.connectionId === connectionId);
  if (
    connection?.catalogItemSlug !== OPENMONTAGE_MCP_CATALOG_SLUG ||
    !connection.approvedTools.includes("submit_video_job")
  ) {
    return Response.json({ error: "Connection is not authorized to submit OpenMontage Jobs." }, { status: 422 });
  }

  let submitted;
  try {
    submitted = parseOpenMontageSubmittedJob(body.snapshot);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid OpenMontage Job snapshot." },
      { status: 400 },
    );
  }

  const employeeId = task.employeeId?.trim() || task.agentId.trim();
  const channelName = resolveChannelName(task.inputJson);
  const conversationId = task.routerSessionId?.trim() || channelName;
  const expectedAttribution: OpenMontageJobAttribution = {
    workspaceId: auth.workspaceId,
    employeeId,
    runtimeId: task.runtimeId,
    rootTaskId: task.id,
    conversationId,
    sourceInvocationId: submitted.attribution.sourceInvocationId,
    traceId: task.id,
  };
  if (!channelName || !matchesAttribution(submitted.attribution, expectedAttribution)) {
    return Response.json({ error: "OpenMontage Job attribution does not match the trusted task." }, { status: 422 });
  }

  try {
    const result = await bindOpenMontageJobDelegationAsync({
      ...expectedAttribution,
      runtimeCredentialId: task.runtimeCredentialId,
      connectionId,
      channelName,
      budget: submitted.budget,
      snapshot: submitted.snapshot,
    });
    return Response.json({ jobId: result.link.jobId }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenMontageJobBindingError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof OpenMontageDelegationValidationError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof OpenMontageDelegationConfigurationError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}

function resolveChannelName(inputJson: string): string {
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    for (const field of ["channelName", "channel", "contactId"] as const) {
      const value = input[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    return "";
  }
  return "";
}

function matchesAttribution(
  actual: OpenMontageJobAttribution,
  expected: OpenMontageJobAttribution,
): boolean {
  return (Object.keys(expected) as Array<keyof OpenMontageJobAttribution>)
    .every((field) => actual[field] === expected[field]);
}
