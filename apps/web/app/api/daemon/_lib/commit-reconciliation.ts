import {
  completeAgentChannelReplySync,
  completeChannelDocumentRunStepSync,
  completeWorkflowTaskIfLinkedSync,
  continueAutoContinuationAfterTaskSync,
  failWorkflowTaskIfLinkedSync,
  lockWorkflowRunForTaskIfLinkedSync,
  prepareWorkflowTaskOutputSync,
  queueFeishuAgentStatusCardOutboxSync,
  queueFeishuChannelReplyOutboxSync,
  readWorkspaceStateSync,
  readWorkspaceAttachmentBytesSync,
  reconcileStaleCommitJournalsSync,
  resolveCompatibleDirectChannelRecord,
  updateTaskStatusSync,
  upsertDirectConversationStateSync,
  writeConversationExecutionWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "@dofe-agent/services";
import {
  appendTaskMessageSync,
  completeCommittedTaskSync,
  failQueuedTaskSync,
  getDatabase,
  readAgentRuntimeSync,
  recordTokenUsageSync,
  type QueuedTaskRecord,
  withTransaction,
} from "@dofe-agent/db";
import { loadTaskOutputEnvelope, parseTaskPayload } from "dofe-agent-daemon";
import {
  getDaemonTaskOutputStagingDir,
  clearDaemonTaskOutputStaging,
  readTaskCompletionEffectsSnapshot,
  readStagedWorkDirDeletedPaths,
  readStagedWorkDirFiles,
} from "./output-bundle";
import { existsSync } from "node:fs";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";

/**
 * Derives a task's durable outputs from the daemon output staging dir, for the
 * commit-reconciliation worker. Mirrors the promotion inputs the complete route
 * builds (staged workDir files + tombstones + the runtime-output envelope's
 * attachments, re-read from the persisted attachment store). Returns null when
 * the staging is gone or unreadable — the reconciliation treats that as
 * unrecoverable.
 */
function deriveStagedTaskOutputsForReconciliation(task: QueuedTaskRecord): {
  outputs: Array<{ path: string; bytes: Uint8Array; mediaType?: string; mode?: string }>;
  deletedPaths: string[];
} | null {
  const stagingDir = getDaemonTaskOutputStagingDir(task.id, task.workspaceId);
  if (!existsSync(stagingDir)) {
    return null;
  }
  try {
    const envelope = loadTaskOutputEnvelope(stagingDir, "", task.workspaceId, {
      attachmentNamespace: task.id,
    });
    return {
      outputs: [
        ...readStagedWorkDirFiles(task.id, task.workspaceId),
        ...envelope.attachments.map((attachment) => ({
          path: attachment.fileName,
          bytes: readWorkspaceAttachmentBytesSync(attachment),
          mediaType: attachment.mediaType,
        })),
      ],
      deletedPaths: readStagedWorkDirDeletedPaths(task.id, task.workspaceId),
    };
  } catch {
    return null;
  }
}

function isTaskCompletionReplaySafe(task: QueuedTaskRecord): boolean {
  const snapshot = readTaskCompletionEffectsSnapshot<ReconciledTaskCompletionSnapshot>(task.id, task.workspaceId);
  return Boolean(snapshot?.effects);
}

/** Maintenance-cron stage: re-drives stale preparing_commit journals. */
export function runCommitReconciliationStage(): {
  committed: number;
  retried: number;
  rolledBack: number;
  skipped: number;
} {
  return reconcileStaleCommitJournalsSync({
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: deriveStagedTaskOutputsForReconciliation,
    isReplaySafe: isTaskCompletionReplaySafe,
    finalizeTask: finalizeReconciledTask,
    abortTask: abortReconciledTask,
  });
}

function abortReconciledTask(task: QueuedTaskRecord, message: string): void {
  const aborted = withTransaction(getDatabase(), () => {
    const fence = lockWorkflowRunForTaskIfLinkedSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      allowPreparingCommit: true,
    });
    if (fence.ignored) return false;
    failQueuedTaskSync({ taskId: task.id, errorText: message, errorCode: "workflow_completion_effect_uncertain" });
    failWorkflowTaskIfLinkedSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      errorCode: "workflow_completion_effect_uncertain",
      errorText: message,
    });
    return true;
  });
  if (!aborted) throw new Error("workflow_commit_abort_conflict");
  clearDaemonTaskOutputStaging(task.id, task.workspaceId);
}

export interface ReconciledTaskCompletionTokenUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  gatewayRequestId?: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  channelName?: string;
}

interface ReconciledTaskCompletionSnapshot {
  finalOutputText?: string;
  normalizedWorkflowOutput?: Record<string, unknown>;
  provider?: string;
  runtimeName?: string;
  sessionId?: string;
  conversationSessionId?: string | null;
  workDir?: string;
  tokenUsage?: ReconciledTaskCompletionTokenUsage;
  effects?: {
    documentOperations: { warnings: string[]; documentUpdates: Array<{ documentId: string; documentVersionId: string }> };
    skillImportOperations: { imports: unknown[] };
    documentRuntimeOutputOperations: { permissionRequests: unknown[] };
    feishuLarkCliResultOperations: { operationRunIds: string[] };
    feishuRuntimeDataOperationRequests: { operationRunIds: string[]; approvalIds: string[] };
    knowledgeProposalOperations: { knowledgeProposals: unknown[] };
  };
}

export function finalizeReconciledTask(task: QueuedTaskRecord): void {
  const stagingDir = getDaemonTaskOutputStagingDir(task.id, task.workspaceId);
  const stagedSnapshot = readTaskCompletionEffectsSnapshot<ReconciledTaskCompletionSnapshot>(task.id, task.workspaceId);
  const storedCompletion = task.status === "completed" ? readStoredTaskCompletion(task) : null;
  const snapshot = stagedSnapshot?.effects ? stagedSnapshot : storedCompletion?.snapshot;
  if (!snapshot || typeof snapshot.finalOutputText !== "string" || !snapshot.effects) {
    throw new Error("workflow_commit_snapshot_missing");
  }
  const envelope = stagedSnapshot?.effects
    ? loadTaskOutputEnvelope(stagingDir, snapshot.finalOutputText, task.workspaceId, {
        attachmentNamespace: task.id,
      })
    : { text: snapshot.finalOutputText, attachments: storedCompletion?.attachments ?? [] };
  const normalizedOutput = snapshot.normalizedWorkflowOutput ?? (task.status === "completed" ? undefined : prepareWorkflowTaskOutputSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      outputText: envelope.text,
    }));
  const payload = parseTaskPayload(task);
  const agentName = payload.assignee ?? task.agentId;
  const tokenUsage = normalizeReconciledTaskCompletionTokenUsage(snapshot.tokenUsage);
  if (tokenUsage) {
    recordTokenUsageSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      agentId: agentName,
      modelId: tokenUsage.modelId,
      providerAccountId: tokenUsage.providerAccountId,
      runtimeCredentialId: tokenUsage.runtimeCredentialId,
      routerSessionId: tokenUsage.routerSessionId ?? task.routerSessionId,
      gatewayRequestId: tokenUsage.gatewayRequestId ?? `task:${task.id}:completion`,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      channelName: tokenUsage.channelName,
    });
  }
  const finalized = withTransaction(getDatabase(), () => {
    const fence = lockWorkflowRunForTaskIfLinkedSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      allowPreparingCommit: true,
      allowCommitted: true,
    });
    if (fence.ignored) return fence.taskStatus === "completed";
    completeCommittedTaskSync({
      taskId: task.id,
      resultJson: {
        provider: snapshot.provider,
        output: envelope.text,
        attachments: envelope.attachments,
        skillImports: snapshot.effects!.skillImportOperations.imports,
        documentUpdates: snapshot.effects!.documentOperations.documentUpdates,
        feishuLarkCliDataOperationRunIds: snapshot.effects!.feishuLarkCliResultOperations.operationRunIds,
        feishuRuntimeDataOperationRunIds: snapshot.effects!.feishuRuntimeDataOperationRequests.operationRunIds,
        feishuRuntimeDataOperationApprovalIds: snapshot.effects!.feishuRuntimeDataOperationRequests.approvalIds,
        documentPermissionRequests: snapshot.effects!.documentRuntimeOutputOperations.permissionRequests,
        knowledgeProposals: snapshot.effects!.knowledgeProposalOperations.knowledgeProposals,
        ...(tokenUsage ? { tokenUsage } : {}),
        recoveredFromCommitJournal: true,
      },
      sessionId: snapshot.sessionId,
      workDir: snapshot.workDir,
    });
    completeWorkflowTaskIfLinkedSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      outputText: envelope.text,
      normalizedOutput,
      artifactManifest: envelope.attachments,
    });
    return true;
  });
  if (!finalized) throw new Error("workflow_commit_finalization_conflict");
  const runtime = readAgentRuntimeSync(task.runtimeId);
  projectTaskCompletion({
    task,
    finalOutputText: snapshot.finalOutputText,
    attachments: envelope.attachments,
    runtimeName: snapshot.runtimeName,
    conversationSessionId: resolveReconciledConversationSessionId({
      snapshot,
      runtimeProvider: runtime?.provider,
    }),
    workDir: snapshot.workDir,
    documentOperations: snapshot.effects.documentOperations,
  });
  clearDaemonTaskOutputStaging(task.id, task.workspaceId);
}

function readStoredTaskCompletion(task: QueuedTaskRecord): {
  snapshot: ReconciledTaskCompletionSnapshot;
  attachments: MessageAttachment[];
} | null {
  if (!task.resultJson) return null;
  try {
    const result = JSON.parse(task.resultJson) as Record<string, unknown>;
    if (typeof result.output !== "string" || !Array.isArray(result.attachments)) return null;
    const attachments = result.attachments.filter(isMessageAttachment);
    if (attachments.length !== result.attachments.length) return null;
    const documentUpdates = Array.isArray(result.documentUpdates)
      ? result.documentUpdates.filter(isDocumentUpdate)
      : [];
    const tokenUsage = normalizeReconciledTaskCompletionTokenUsage(result.tokenUsage);
    return {
      attachments,
      snapshot: {
        finalOutputText: result.output,
        provider: typeof result.provider === "string" ? result.provider : undefined,
        sessionId: task.sessionId,
        conversationSessionId: result.provider === "hermes" ? null : task.sessionId ?? null,
        workDir: task.workDir,
        ...(tokenUsage ? { tokenUsage } : {}),
        effects: {
          documentOperations: { warnings: [], documentUpdates },
          skillImportOperations: { imports: Array.isArray(result.skillImports) ? result.skillImports : [] },
          documentRuntimeOutputOperations: {
            permissionRequests: Array.isArray(result.documentPermissionRequests) ? result.documentPermissionRequests : [],
          },
          feishuLarkCliResultOperations: {
            operationRunIds: readStringArray(result.feishuLarkCliDataOperationRunIds),
          },
          feishuRuntimeDataOperationRequests: {
            operationRunIds: readStringArray(result.feishuRuntimeDataOperationRunIds),
            approvalIds: readStringArray(result.feishuRuntimeDataOperationApprovalIds),
          },
          knowledgeProposalOperations: {
            knowledgeProposals: Array.isArray(result.knowledgeProposals) ? result.knowledgeProposals : [],
          },
        },
      },
    };
  } catch {
    return null;
  }
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.id === "string" && typeof attachment.fileName === "string" &&
    typeof attachment.mediaType === "string" && typeof attachment.sizeBytes === "number" &&
    (attachment.kind === "image" || attachment.kind === "file") && typeof attachment.storedPath === "string";
}

function isDocumentUpdate(value: unknown): value is { documentId: string; documentVersionId: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).documentId === "string" &&
    typeof (value as Record<string, unknown>).documentVersionId === "string";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeReconciledTaskCompletionTokenUsage(value: unknown): ReconciledTaskCompletionTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.modelId !== "string" || !usage.modelId.trim()) return undefined;
  if (typeof usage.inputTokens !== "number"
    || !Number.isFinite(usage.inputTokens)
    || !Number.isInteger(usage.inputTokens)
    || usage.inputTokens < 0
    || typeof usage.outputTokens !== "number"
    || !Number.isFinite(usage.outputTokens)
    || !Number.isInteger(usage.outputTokens)
    || usage.outputTokens < 0
    || (usage.inputTokens === 0 && usage.outputTokens === 0)) return undefined;
  return {
    modelId: usage.modelId.trim(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.gatewayRequestId === "string" && usage.gatewayRequestId.trim()
      ? { gatewayRequestId: usage.gatewayRequestId.trim() } : {}),
    ...(typeof usage.providerAccountId === "string" && usage.providerAccountId.trim()
      ? { providerAccountId: usage.providerAccountId.trim() } : {}),
    ...(typeof usage.runtimeCredentialId === "string" && usage.runtimeCredentialId.trim()
      ? { runtimeCredentialId: usage.runtimeCredentialId.trim() } : {}),
    ...(typeof usage.routerSessionId === "string" && usage.routerSessionId.trim()
      ? { routerSessionId: usage.routerSessionId.trim() } : {}),
    ...(typeof usage.channelName === "string" && usage.channelName.trim()
      ? { channelName: usage.channelName.trim() } : {}),
  };
}

export function projectTaskCompletion(input: {
  task: QueuedTaskRecord;
  finalOutputText: string;
  attachments: MessageAttachment[];
  runtimeName?: string;
  conversationSessionId: string | null;
  workDir?: string;
  documentOperations: {
    warnings: string[];
    documentUpdates: Array<{ documentId: string; documentVersionId: string }>;
  };
}): void {
  const { task } = input;
  const payload = parseTaskPayload(task);
  const runtime = readAgentRuntimeSync(task.runtimeId);
  const agentName = payload.assignee ?? task.agentId;
  const runtimeName = input.runtimeName ?? runtime?.name ?? agentName;
  const workspaceState = readWorkspaceStateSync(task.workspaceId);
  const effectiveChannelName = payload.channelName
    ?? (payload.contactId ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name : undefined);
  const { conversationSessionId, documentOperations } = input;

  if (payload.taskId) updateTaskStatusSync(payload.taskId, "done", task.workspaceId);
  if (payload.orchestrationStepId) {
    writeWorkspaceStateSync(completeChannelDocumentRunStepSync({
      queuedTaskId: task.id,
      documentUpdates: documentOperations.documentUpdates,
      warningText: documentOperations.warnings[0],
    }, task.workspaceId), task.workspaceId);
  }

  if (effectiveChannelName && payload.channel) {
    const reply = completeAgentChannelReplySync({
      channel: payload.channel,
      pendingSpeaker: agentName,
      speaker: payload.assignee ?? runtimeName,
      summary: input.finalOutputText,
      attachments: input.attachments,
      sourceTaskQueueId: task.id,
      requestedByUserId: task.requestedByUserId,
      requestedByDisplayName: task.requestedByDisplayName,
      mentionCascadeDepth: payload.mentionCascadeDepth,
      mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
      sessionId: conversationSessionId ?? undefined,
      workDir: input.workDir,
    }, task.workspaceId);
    recordTaskReplyEffects(
      task,
      payload.channel,
      agentName,
      input.finalOutputText,
      input.attachments,
      reply,
      payload.sourceMessageId,
    );
    writeConversationExecutionWorkspaceStateSync({
      channelName: payload.channel,
      agentId: agentName,
      contactId: payload.contactId,
      sessionId: conversationSessionId,
      workDir: input.workDir,
      lastTaskQueueId: task.id,
      lastError: null,
    }, task.workspaceId);
    if (payload.contactId) {
      upsertDirectConversationStateSync({
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: input.workDir,
      }, task.workspaceId);
    }
  } else if (payload.contactId) {
    writeConversationExecutionWorkspaceStateSync({
      channelName: effectiveChannelName ?? payload.channel ?? payload.contactId,
      agentId: payload.contactId,
      contactId: payload.contactId,
      sessionId: conversationSessionId,
      workDir: input.workDir,
      lastTaskQueueId: task.id,
      lastError: null,
    }, task.workspaceId);
    upsertDirectConversationStateSync({
      contactId: payload.contactId,
      sessionId: conversationSessionId,
      workDir: input.workDir,
    }, task.workspaceId);
  } else if (payload.channel) {
    const reply = completeAgentChannelReplySync({
      channel: payload.channel,
      speaker: runtimeName,
      summary: input.finalOutputText,
      attachments: input.attachments,
      sourceTaskQueueId: task.id,
      requestedByUserId: task.requestedByUserId,
      requestedByDisplayName: task.requestedByDisplayName,
      mentionCascadeDepth: payload.mentionCascadeDepth,
      mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
      sessionId: conversationSessionId ?? undefined,
      workDir: input.workDir,
    }, task.workspaceId);
    recordTaskReplyEffects(
      task,
      payload.channel,
      agentName,
      input.finalOutputText,
      input.attachments,
      reply,
      payload.sourceMessageId,
    );
    writeConversationExecutionWorkspaceStateSync({
      channelName: payload.channel,
      agentId: agentName,
      sessionId: conversationSessionId,
      workDir: input.workDir,
      lastTaskQueueId: task.id,
      lastError: null,
    }, task.workspaceId);
  }

  try {
    continueAutoContinuationAfterTaskSync({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: conversationSessionId ?? undefined,
      workDir: input.workDir,
    });
  } catch {
    // The original completion path also treats automatic continuation as best effort.
  }
}

export function resolveReconciledConversationSessionId(input: {
  snapshot: Pick<ReconciledTaskCompletionSnapshot, "provider" | "sessionId" | "conversationSessionId">;
  runtimeProvider?: string;
}): string | null {
  if (Object.hasOwn(input.snapshot, "conversationSessionId")) {
    return input.snapshot.conversationSessionId ?? null;
  }
  return (input.snapshot.provider ?? input.runtimeProvider) === "hermes"
    ? null
    : input.snapshot.sessionId ?? null;
}

export function resolveTaskCompletionSnapshotMetadata(input: {
  snapshot: Pick<ReconciledTaskCompletionSnapshot, "provider" | "sessionId" | "conversationSessionId" | "workDir">;
  runtimeProvider?: string;
}): {
  providerSessionId?: string;
  conversationSessionId: string | null;
  workDir?: string;
} {
  return {
    providerSessionId: input.snapshot.sessionId,
    conversationSessionId: resolveReconciledConversationSessionId(input),
    workDir: input.snapshot.workDir,
  };
}

function recordTaskReplyEffects(
  task: QueuedTaskRecord,
  channelName: string,
  agentName: string,
  text: string,
  attachments: ReturnType<typeof loadTaskOutputEnvelope>["attachments"],
  reply: ReturnType<typeof completeAgentChannelReplySync>,
  sourceDofeAgentMessageId?: string,
): void {
  for (const warning of reply.warnings) {
    appendTaskMessageSync({ taskId: task.id, type: "status", content: warning });
  }
  try {
    const statusCards = queueFeishuAgentStatusCardOutboxSync({
      workspaceId: task.workspaceId,
      channelName,
      agentId: agentName,
      status: "complete",
      agentNames: [agentName],
      message: text,
      taskId: task.id,
      dofeAgentMessageId: reply.message.id,
      sourceDofeAgentMessageId,
    });
    const replies = queueFeishuChannelReplyOutboxSync({
      workspaceId: task.workspaceId,
      channelName,
      agentId: agentName,
      text,
      attachments,
      dofeAgentMessageId: reply.message.id,
      sourceDofeAgentMessageId,
    });
    if (statusCards.length + replies.length > 0) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `Feishu outbound queued: ${statusCards.length + replies.length} message(s).`,
      });
    }
  } catch (error) {
    const message = `Feishu outbound enqueue failed: ${error instanceof Error ? error.message : String(error)}`;
    appendTaskMessageSync({ taskId: task.id, type: "status", content: message });
    throw new Error("workflow_completion_feishu_outbox_failed", { cause: error });
  }
}
