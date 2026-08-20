// 3.5-4：自 task-context.ts 拆出——任务 inputJson 的结构化解析与线程 ID 解析。
import { type QueuedTaskRecord, type WorkflowTaskMetadata } from "@dofe-agent/db";
import type { WorkspaceDataPolicyDecision } from "@dofe-agent/services/operations";

export interface ParsedTaskPayload {
  taskId?: string;
  assignee?: string;
  title?: string;
  channel?: string;
  priority?: string;
  workflowNodeInput?: Record<string, unknown>;
  workflow?: WorkflowTaskMetadata;
  contactId?: string;
  channelName?: string;
  channelMessage?: string;
  conversationId?: string;
  executionLaneId?: string;
  externalInput?: {
    provider: string;
    providerLabel?: string;
    externalEventId?: string;
    externalMessageId?: string;
    externalChatId?: string;
    trust: "untrusted_user_message";
    actor?: {
      actorType: "user" | "external_guest";
      userId?: string;
      externalActorReference?: string;
      externalGuestPermissionProfile?: string;
      externalGuestRequireIdentityFor?: string[];
      agentId?: string;
      botBindingId?: string;
    };
    workspaceDataPolicy?: WorkspaceDataPolicyDecision;
  };
  sourceChannel?: string;
  sourceMessageId?: string;
  sourceTaskQueueId?: string;
  mentionSource?: string;
  initiatorAgentId?: string;
  mentionCascadeDepth?: number;
  mentionRootMessageId?: string;
  orchestrationRunId?: string;
  orchestrationStepId?: string;
  stepInstruction?: string;
  stepDependsOnIds?: string[];
  stepHandoffKind?: string;
  handoffDocumentIds?: string[];
  handoffDocumentVersionIds?: string[];
  autoContinuation?: {
    mode: "until";
    status: "active" | "expired" | "stopped";
    startedAt: string;
    until: string;
    instruction: string;
    iteration: number;
    lastContinuedAt?: string;
  };
  mentionType?: string;
  mentionedAgentIds?: string[];
  mentionedAgentLabels?: string[];
  assigneeMentionToken?: string;
  channelHistory?: Array<{
    speaker: string;
    role?: string;
    summary: string;
    time?: string;
    status?: string;
    kind?: string;
    processType?: string;
    mentions?: string[];
    attachments?: string[];
  }>;
  channelHistoryPath?: string;
  channelSessionId?: string;
  attachments?: Array<{
    fileName: string;
    storedPath: string;
    mediaType?: string;
    kind?: string;
    storageProvider?: "tos" | "local";
    storageBucket?: string;
    storageRegion?: string;
    storageEndpoint?: string;
    storageKey?: string;
  }>;
}

type ParsedExternalInputActor = NonNullable<NonNullable<ParsedTaskPayload["externalInput"]>["actor"]>;

export function parseTaskInputJson(inputJson: string): ParsedTaskPayload {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return {
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
      assignee: typeof parsed.assignee === "string" ? parsed.assignee : undefined,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
      priority: typeof parsed.priority === "string" ? parsed.priority : undefined,
      workflowNodeInput: isPlainRecord(parsed.workflowNodeInput) ? parsed.workflowNodeInput : undefined,
      workflow: parseWorkflowTaskMetadata(parsed.workflow),
      contactId: typeof parsed.contactId === "string" ? parsed.contactId : undefined,
      channelName: typeof parsed.channelName === "string" ? parsed.channelName : undefined,
      channelMessage: typeof parsed.channelMessage === "string" ? parsed.channelMessage : undefined,
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : undefined,
      executionLaneId: typeof parsed.executionLaneId === "string" ? parsed.executionLaneId : undefined,
      externalInput: parseExternalInputPayload(parsed.externalInput),
      sourceChannel: typeof parsed.sourceChannel === "string" ? parsed.sourceChannel : undefined,
      sourceMessageId: typeof parsed.sourceMessageId === "string" ? parsed.sourceMessageId : undefined,
      sourceTaskQueueId: typeof parsed.sourceTaskQueueId === "string" ? parsed.sourceTaskQueueId : undefined,
      mentionSource: typeof parsed.mentionSource === "string" ? parsed.mentionSource : undefined,
      initiatorAgentId: typeof parsed.initiatorAgentId === "string" ? parsed.initiatorAgentId : undefined,
      mentionCascadeDepth: typeof parsed.mentionCascadeDepth === "number" && Number.isFinite(parsed.mentionCascadeDepth)
        ? parsed.mentionCascadeDepth
        : undefined,
      mentionRootMessageId: typeof parsed.mentionRootMessageId === "string" ? parsed.mentionRootMessageId : undefined,
      orchestrationRunId: typeof parsed.orchestrationRunId === "string" ? parsed.orchestrationRunId : undefined,
      orchestrationStepId: typeof parsed.orchestrationStepId === "string" ? parsed.orchestrationStepId : undefined,
      stepInstruction: typeof parsed.stepInstruction === "string" ? parsed.stepInstruction : undefined,
      stepDependsOnIds: Array.isArray(parsed.stepDependsOnIds)
        ? parsed.stepDependsOnIds.filter((item): item is string => typeof item === "string")
        : undefined,
      stepHandoffKind: typeof parsed.stepHandoffKind === "string" ? parsed.stepHandoffKind : undefined,
      handoffDocumentIds: Array.isArray(parsed.handoffDocumentIds)
        ? parsed.handoffDocumentIds.filter((item): item is string => typeof item === "string")
        : undefined,
      handoffDocumentVersionIds: Array.isArray(parsed.handoffDocumentVersionIds)
        ? parsed.handoffDocumentVersionIds.filter((item): item is string => typeof item === "string")
        : undefined,
      autoContinuation: parseAutoContinuationPayload(parsed.autoContinuation),
      mentionType: typeof parsed.mentionType === "string" ? parsed.mentionType : undefined,
      mentionedAgentIds: Array.isArray(parsed.mentionedAgentIds)
        ? parsed.mentionedAgentIds.filter((item): item is string => typeof item === "string")
        : undefined,
      mentionedAgentLabels: Array.isArray(parsed.mentionedAgentLabels)
        ? parsed.mentionedAgentLabels.filter((item): item is string => typeof item === "string")
        : undefined,
      assigneeMentionToken: typeof parsed.assigneeMentionToken === "string" ? parsed.assigneeMentionToken : undefined,
      channelHistory: Array.isArray(parsed.channelHistory)
        ? parsed.channelHistory
            .filter(
              (
                item,
              ): item is {
                speaker: string;
                role?: string;
                summary: string;
                time?: string;
                status?: string;
                kind?: string;
                processType?: string;
                mentions?: string[];
                attachments?: string[];
              } =>
                Boolean(item) &&
                typeof item === "object" &&
                typeof (item as { speaker?: unknown }).speaker === "string" &&
                typeof (item as { summary?: unknown }).summary === "string",
            )
            .map((item) => ({
              speaker: item.speaker,
              role: typeof item.role === "string" ? item.role : undefined,
              summary: item.summary,
              time: typeof item.time === "string" ? item.time : undefined,
              status: typeof item.status === "string" ? item.status : undefined,
              kind: typeof item.kind === "string" ? item.kind : undefined,
              processType: typeof item.processType === "string" ? item.processType : undefined,
              mentions: Array.isArray(item.mentions)
                ? item.mentions.filter((entry): entry is string => typeof entry === "string")
                : undefined,
              attachments: Array.isArray(item.attachments)
                ? item.attachments.filter((entry): entry is string => typeof entry === "string")
                : undefined,
            }))
        : undefined,
      channelHistoryPath: typeof parsed.channelHistoryPath === "string" ? parsed.channelHistoryPath : undefined,
      channelSessionId: typeof parsed.channelSessionId === "string" ? parsed.channelSessionId : undefined,
      attachments: Array.isArray(parsed.attachments)
        ? parsed.attachments
            .filter(
              (item): item is {
                fileName: string;
                storedPath: string;
                mediaType?: string;
                kind?: string;
                storageProvider?: "tos" | "local";
                storageBucket?: string;
                storageRegion?: string;
                storageEndpoint?: string;
                storageKey?: string;
              } =>
                Boolean(item) &&
                typeof item === "object" &&
                typeof (item as { fileName?: unknown }).fileName === "string" &&
                typeof (item as { storedPath?: unknown }).storedPath === "string",
            )
            .map((item) => ({
              fileName: item.fileName,
              storedPath: item.storedPath,
              mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
              kind: typeof item.kind === "string" ? item.kind : undefined,
              storageProvider:
                item.storageProvider === "tos" || item.storageProvider === "local"
                  ? item.storageProvider
                  : undefined,
              storageBucket: typeof item.storageBucket === "string" ? item.storageBucket : undefined,
              storageRegion: typeof item.storageRegion === "string" ? item.storageRegion : undefined,
              storageEndpoint: typeof item.storageEndpoint === "string" ? item.storageEndpoint : undefined,
              storageKey: typeof item.storageKey === "string" ? item.storageKey : undefined,
            }))
        : undefined,
    };
  } catch {
    return {};
  }
}

function parseWorkflowTaskMetadata(input: unknown): WorkflowTaskMetadata | undefined {
  if (!isPlainRecord(input)) return undefined;
  const requiredStrings = [
    "workflowId",
    "workflowVersionId",
    "workflowRunId",
    "workflowNodeId",
    "workflowNodeRunId",
  ] as const;
  if (requiredStrings.some((key) => typeof input[key] !== "string")) return undefined;
  if (!Number.isInteger(input.attempt) || Number(input.attempt) < 1) return undefined;
  if (!Array.isArray(input.artifactRefs) || !input.artifactRefs.every((value) => typeof value === "string")) return undefined;
  return {
    workflowId: input.workflowId as string,
    workflowVersionId: input.workflowVersionId as string,
    workflowRunId: input.workflowRunId as string,
    workflowNodeId: input.workflowNodeId as string,
    workflowNodeRunId: input.workflowNodeRunId as string,
    attempt: Number(input.attempt),
    artifactRefs: input.artifactRefs as string[],
    outputSchema: isPlainRecord(input.outputSchema) ? input.outputSchema : undefined,
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function parseAutoContinuationPayload(input: unknown): ParsedTaskPayload["autoContinuation"] {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (
    value.mode !== "until" ||
    (value.status !== "active" && value.status !== "expired" && value.status !== "stopped") ||
    typeof value.startedAt !== "string" ||
    typeof value.until !== "string" ||
    typeof value.instruction !== "string"
  ) {
    return undefined;
  }
  return {
    mode: "until",
    status: value.status,
    startedAt: value.startedAt,
    until: value.until,
    instruction: value.instruction,
    iteration: typeof value.iteration === "number" && Number.isFinite(value.iteration) ? value.iteration : 0,
    lastContinuedAt: typeof value.lastContinuedAt === "string" ? value.lastContinuedAt : undefined,
  };
}

function parseExternalInputPayload(input: unknown): ParsedTaskPayload["externalInput"] {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (typeof value.provider !== "string" || value.trust !== "untrusted_user_message") {
    return undefined;
  }
  return {
    provider: value.provider,
    providerLabel: typeof value.providerLabel === "string" ? value.providerLabel : undefined,
    externalEventId: typeof value.externalEventId === "string" ? value.externalEventId : undefined,
    externalMessageId: typeof value.externalMessageId === "string" ? value.externalMessageId : undefined,
    externalChatId: typeof value.externalChatId === "string" ? value.externalChatId : undefined,
    trust: "untrusted_user_message",
    actor: parseExternalInputActor(value.actor),
    workspaceDataPolicy: parseWorkspaceDataPolicyDecision(value.workspaceDataPolicy),
  };
}

function parseExternalInputActor(input: unknown): ParsedExternalInputActor | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (value.actorType !== "user" && value.actorType !== "external_guest") {
    return undefined;
  }
  return {
    actorType: value.actorType,
    ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
    ...(typeof value.externalActorReference === "string" ? { externalActorReference: value.externalActorReference } : {}),
    ...(typeof value.externalGuestPermissionProfile === "string" ? { externalGuestPermissionProfile: value.externalGuestPermissionProfile } : {}),
    ...(Array.isArray(value.externalGuestRequireIdentityFor)
      ? {
          externalGuestRequireIdentityFor: value.externalGuestRequireIdentityFor
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        }
      : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.botBindingId === "string" ? { botBindingId: value.botBindingId } : {}),
  };
}

function parseWorkspaceDataPolicyDecision(input: unknown): WorkspaceDataPolicyDecision | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (
    value.decision !== "allow" &&
    value.decision !== "deny"
  ) {
    return undefined;
  }
  if (
    value.classification !== "native_workspace_content" &&
    value.classification !== "external_untrusted_user_content"
  ) {
    return undefined;
  }
  if (typeof value.reasonCode !== "string" || typeof value.reason !== "string") {
    return undefined;
  }
  if (!value.allowedUses || typeof value.allowedUses !== "object") {
    return undefined;
  }
  const allowedUses = value.allowedUses as Record<string, unknown>;
  if (
    typeof allowedUses.storeInWorkspace !== "boolean" ||
    typeof allowedUses.includeInSearch !== "boolean" ||
    typeof allowedUses.includeInAgentContext !== "boolean"
  ) {
    return undefined;
  }
  return {
    decision: value.decision,
    reasonCode: value.reasonCode,
    reason: value.reason,
    classification: value.classification,
    allowedUses: {
      storeInWorkspace: allowedUses.storeInWorkspace,
      includeInSearch: allowedUses.includeInSearch,
      includeInAgentContext: allowedUses.includeInAgentContext,
    },
    auditData: value.auditData && typeof value.auditData === "object"
      ? value.auditData as Record<string, unknown>
      : {},
  };
}

export function parseTaskPayload(task: QueuedTaskRecord): ParsedTaskPayload {
  return parseTaskInputJson(task.inputJson);
}

export function resolveConversationThreadId(input: {
  triggerType: string;
  payload: Pick<ParsedTaskPayload, "channel" | "channelName" | "contactId" | "conversationId">;
}): string | undefined {
  const isConversationTrigger = input.triggerType === "channel_chat" || input.triggerType === "mention_chat";
  if (!isConversationTrigger && !input.payload.contactId) {
    return undefined;
  }

  // 会话拆分：有 conversationId 时，workDir 按 Conversation 隔离，不按频道共享（docs §4.2）。
  if (input.payload.conversationId) {
    return `conversation:${input.payload.conversationId}`;
  }
  return input.payload.channelName ?? input.payload.channel;
}
