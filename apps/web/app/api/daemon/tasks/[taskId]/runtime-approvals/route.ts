import { createExternalMessageOutboxSync, readQueuedTaskSync } from "@dofe-agent/db";
import {
  buildFeishuIdentityBindingRequiredCard,
  buildFeishuInteractiveCardOutboundMessage,
  createRuntimeToolApprovalRequestSync,
  evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput,
  listApprovalsSync,
  reviewApprovalSync,
  type FeishuRuntimeToolIdentityRequirement,
} from "@dofe-agent/services";
import type { CreateRuntimeApprovalRequest } from "@dofe-agent/domain";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const terminalResponse = rejectApprovalForTerminalTask(task.status);
  if (terminalResponse) {
    return terminalResponse;
  }

  const body = (await request.json()) as Partial<CreateRuntimeApprovalRequest>;
  if (!body.provider || !body.runtimeId || !body.toolName || !body.contentPreview) {
    return Response.json({ error: "provider, runtimeId, toolName, and contentPreview are required." }, { status: 400 });
  }
  if (body.runtimeId !== task.runtimeId) {
    return Response.json({ error: "Runtime approval does not match the task runtime." }, { status: 400 });
  }

  const identityRequirement = evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(task.inputJson);
  if (identityRequirement.required) {
    const identityNoticeQueued = queueFeishuRuntimeToolIdentityRequiredNoticeBestEffort({
      workspaceId: auth.workspaceId,
      taskAgentId: task.agentId,
      identityRequirement,
    });
    return Response.json({
      error: "External guests must bind an agent.dofe identity before approving runtime-sensitive tools.",
      errorCode: "feishu.runtime_tool_external_guest_requires_identity",
      reasonCode: identityRequirement.reasonCode,
      requireIdentity: true,
      actorType: "external_guest",
      externalActorReference: identityRequirement.externalActorReference,
      identityNoticeQueued,
    }, { status: 403 });
  }

  const latestTask = readQueuedTaskSync(task.id);
  const latestTerminalResponse = rejectApprovalForTerminalTask(latestTask?.status);
  if (latestTerminalResponse) {
    return latestTerminalResponse;
  }

  const approval = createRuntimeToolApprovalRequestSync({
    sourceId: task.id,
    agentId: task.agentId,
    channelName: resolveTaskChannelName(task.inputJson),
    toolName: body.toolName,
    toolInput: body.toolInput,
    contentPreview: body.contentPreview,
    provider: body.provider,
    runtimeId: body.runtimeId,
    sessionId: body.sessionId,
  }, auth.workspaceId);

  const taskAfterApproval = readQueuedTaskSync(task.id);
  const postCreateTerminalResponse = rejectApprovalForTerminalTask(taskAfterApproval?.status);
  if (postCreateTerminalResponse) {
    const currentApproval = listApprovalsSync(auth.workspaceId).find((item) => item.id === approval.id);
    if (currentApproval?.status === "pending") {
      reviewApprovalSync(
        approval.id,
        "rejected",
        "Task stopped before the approval request was delivered.",
        auth.workspaceId,
        { suppressConversationMessage: true },
      );
    }
    return postCreateTerminalResponse;
  }

  return Response.json({
    approval: {
      approvalId: approval.id,
      status: approval.status,
      reviewerComment: approval.reviewerComment,
    },
  });
}

function rejectApprovalForTerminalTask(status: string | undefined): Response | null {
  if (status === "cancelled") {
    return Response.json({
      error: "Runtime approval cannot be created for a cancelled task.",
      errorCode: "task_cancelled",
    }, { status: 409 });
  }
  if (status === "completed" || status === "failed") {
    return Response.json({
      error: "Runtime approval cannot be created for a terminal task.",
      errorCode: "task_terminal",
    }, { status: 409 });
  }
  return null;
}

function resolveTaskChannelName(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return readString(parsed.channelName) ?? readString(parsed.channel) ?? readString(parsed.contactId) ?? "";
  } catch {
    return "";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queueFeishuRuntimeToolIdentityRequiredNoticeBestEffort(input: {
  workspaceId: string;
  taskAgentId: string;
  identityRequirement: FeishuRuntimeToolIdentityRequirement;
}): boolean {
  const integrationId = input.identityRequirement.botBindingId;
  const targetExternalChatId = input.identityRequirement.externalChatId;
  if (!integrationId || !targetExternalChatId) {
    return false;
  }
  try {
    const outbound = buildFeishuInteractiveCardOutboundMessage({
      targetExternalChatId,
      targetExternalThreadId: input.identityRequirement.externalMessageId,
      card: buildFeishuIdentityBindingRequiredCard({
        agentId: input.identityRequirement.agentId ?? input.taskAgentId,
      }),
    });
    createExternalMessageOutboxSync({
      workspaceId: input.workspaceId,
      integrationId,
      targetExternalChatId: outbound.targetExternalChatId,
      targetExternalThreadId: outbound.targetExternalThreadId,
      payloadJson: outbound.payload,
    });
    return true;
  } catch {
    return false;
  }
}
