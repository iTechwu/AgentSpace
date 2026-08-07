import {
  readOpenMontageChatBindingSync,
  recordAuditLogSync,
} from "@dofe-agent/db";
import {
  callOpenMontageJobActionAsync,
  canWriteChannelForActorSync,
  OpenMontageJobActionError,
  type OpenMontageJobActionInput,
} from "@dofe-agent/services";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ACTION_BODY_BYTES = 16 * 1024;

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; jobId: string }> },
): Promise<Response> {
  const { workspaceId: workspaceIdentifier, jobId } = await context.params;
  const access = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  if (access.status === "unauthenticated") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (access.status !== "ok") {
    return Response.json({ error: "OpenMontage Job not found." }, { status: 404 });
  }

  const workspaceId = access.context.currentWorkspace.id;
  const actor = {
    userId: access.context.currentUser.id,
    displayName: access.context.currentUser.displayName,
    role: access.context.currentMembership.role,
  };
  const binding = readOpenMontageChatBindingSync(workspaceId, jobId);
  if (!binding) {
    return Response.json({ error: "OpenMontage Job not found." }, { status: 404 });
  }

  let action: Omit<OpenMontageJobActionInput, "workspaceId" | "jobId">;
  try {
    action = parseActionBody(await readBoundedJson(request));
  } catch {
    return Response.json({ error: "openmontage_job_action_invalid" }, { status: 400 });
  }

  if (!canWriteChannelForActorSync({ workspaceId, channelName: binding.channelName, actor })) {
    recordActionAudit({
      workspaceId,
      actorUserId: actor.userId,
      jobId,
      channelName: binding.channelName,
      action: action.action,
      outcome: "denied",
    });
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    await callOpenMontageJobActionAsync({
      workspaceId,
      jobId,
      ...action,
    });
    recordActionAudit({
      workspaceId,
      actorUserId: actor.userId,
      jobId,
      channelName: binding.channelName,
      action: action.action,
      outcome: "accepted",
    });
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const failure = actionFailureDiagnostics(error);
    recordActionAudit({
      workspaceId,
      actorUserId: actor.userId,
      jobId,
      channelName: binding.channelName,
      action: action.action,
      outcome: "failed",
      ...failure,
    });
    return actionErrorResponse(error);
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text || Buffer.byteLength(text, "utf8") > MAX_ACTION_BODY_BYTES) {
    throw new Error("Action body is invalid.");
  }
  return JSON.parse(text) as unknown;
}

function parseActionBody(value: unknown): Omit<OpenMontageJobActionInput, "workspaceId" | "jobId"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Action body is invalid.");
  }
  const source = value as Record<string, unknown>;
  const allowedKeys = new Set(["action", "stage", "expectedSequence"]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
    throw new Error("Action body contains unsupported fields.");
  }
  if (source.action !== "approve" && source.action !== "reject" && source.action !== "cancel") {
    throw new Error("Action is invalid.");
  }
  if (
    typeof source.expectedSequence !== "number"
    || !Number.isInteger(source.expectedSequence)
    || source.expectedSequence < 0
  ) {
    throw new Error("Expected sequence is invalid.");
  }
  const stage = typeof source.stage === "string" ? source.stage.trim() : undefined;
  if ((source.action === "approve" || source.action === "reject") && (!stage || stage.length > 256)) {
    throw new Error("Stage is required for approval actions.");
  }
  if (source.action === "cancel" && source.stage !== undefined) {
    throw new Error("Cancel does not accept a stage.");
  }
  return {
    action: source.action,
    expectedSequence: source.expectedSequence,
    ...(stage ? { stage } : {}),
  };
}

function actionErrorResponse(error: unknown): Response {
  if (error instanceof OpenMontageJobActionError) {
    if (error.downstreamStatus === 404 || error.downstreamStatus === 409) {
      return Response.json({
        error: "openmontage_job_action_conflict",
        message: "This action is no longer available.",
      }, { status: 409 });
    }
    if (error.downstreamStatus === 401 || error.downstreamStatus === 403) {
      return Response.json({
        error: "openmontage_unavailable",
        message: "The video service is not configured.",
      }, { status: 503 });
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (/changed since the action was requested/i.test(message)) {
    return Response.json({
      error: "openmontage_job_changed",
      message: "The video job changed. Refresh and try again.",
    }, { status: 409 });
  }
  if (/no longer actionable|can no longer be cancelled/i.test(message)) {
    return Response.json({
      error: "openmontage_job_action_conflict",
      message: "This action is no longer available.",
    }, { status: 409 });
  }
  if (/OPENMONTAGE_(?:BASE_URL|SERVICE_TOKEN)/.test(message)) {
    return Response.json({
      error: "openmontage_unavailable",
      message: "The video service is not configured.",
    }, { status: 503 });
  }
  return Response.json({
    error: "openmontage_job_action_failed",
    message: "The video service could not accept this action.",
  }, { status: 502 });
}

function actionFailureDiagnostics(error: unknown): {
  downstreamStatus?: number;
  downstreamCode?: string;
  traceId?: string;
} {
  if (!(error instanceof OpenMontageJobActionError)) return {};
  return {
    downstreamStatus: error.downstreamStatus,
    ...(error.downstreamCode ? { downstreamCode: error.downstreamCode } : {}),
    ...(error.traceId ? { traceId: error.traceId } : {}),
  };
}

function recordActionAudit(input: {
  workspaceId: string;
  actorUserId: string;
  jobId: string;
  channelName: string;
  action: OpenMontageJobActionInput["action"];
  outcome: "accepted" | "denied" | "failed";
  downstreamStatus?: number;
  downstreamCode?: string;
  traceId?: string;
}): void {
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "OpenMontage Job action",
    note: `OpenMontage Job action ${input.outcome}.`,
    code: `openmontage_job_action_${input.outcome}`,
    source: "runtime_lifecycle",
    data: {
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      channelName: input.channelName,
      action: input.action,
      outcome: input.outcome,
      ...(input.downstreamStatus !== undefined
        ? { downstreamStatus: input.downstreamStatus }
        : {}),
      ...(input.downstreamCode ? { downstreamCode: input.downstreamCode } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    },
  });
}
