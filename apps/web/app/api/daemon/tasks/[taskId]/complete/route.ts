import {
  appendTaskMessageSync,
  assertEmployeeBindingGenerationSync,
  completeCommittedTaskSync,
  getDatabase,
  failQueuedTaskSync,
  enqueueTokenUsageRetrySync,
  markTaskCommittedSync,
  readAgentRuntimeSync,
  readTaskCommitJournalSync,
  recordTokenUsageSync,
  upsertTaskCommitJournalSync,
  withTransaction,
} from "@dofe-agent/db";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  applyDocumentRuntimeOutputOperations,
  applyChannelDocumentOperations,
  applyKnowledgeProposalOperations,
  applySkillImportOperations,
  discardTaskOutputAttachments,
  loadTaskOutputEnvelope,
  parseTaskPayload,
} from "dofe-agent-daemon";
import type { CompleteTaskRequest } from "@dofe-agent/domain";
import {
  completeChannelDocumentRunStepSync,
  completeAgentChannelReplySync,
  completeWorkflowTaskIfLinkedSync,
  beginWorkflowTaskCommitSync,
  continueAutoContinuationAfterTaskSync,
  failChannelDocumentRunStepSync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  getWorkflowCompletionErrorCode,
  applyFeishuLarkCliResultManifestOperations,
  applyFeishuRuntimeDataOperationRequests,
  listFeishuLarkCliResourceGrantsForChannelSync,
  lockWorkflowRunForTaskIfLinkedSync,
  postMessageSync,
  prepareWorkflowTaskOutputSync,
  promoteTaskOutputsToWorkspaceSync,
  queueFeishuAgentStatusCardOutboxSync,
  queueFeishuChannelReplyOutboxSync,
  readWorkspaceAttachmentBytesSync,
  readWorkspaceStateSync,
  replacePendingChannelMessageSync,
  resolveWorkflowCompletionFailureCode,
  resolveCompatibleDirectChannelRecord,
  AgentDocumentPermissionError,
  resolveAgentRuntimeMode,
  writeConversationExecutionWorkspaceStateSync,
  upsertDirectConversationStateSync,
  updateTaskStatusSync,
  failWorkflowTaskIfLinkedSync,
  writeWorkspaceStateSync,
  type FeishuAgentStatusCardStatus,
} from "@dofe-agent/services";
import { finalizeReconciledTask } from "../../../_lib/commit-reconciliation";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import {
  clearDaemonTaskOutputStaging,
  getDaemonTaskOutputStagingDir,
  materializeOutputBundleToStaging,
  readTaskCompletionEffectsSnapshot,
  readStagedWorkDirDeletedPaths,
  readStagedWorkDirFiles,
  writeTaskCompletionEffectsSnapshot,
} from "../../../_lib/output-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CompleteTaskUsage = NonNullable<CompleteTaskRequest["usages"]>[number];
type TaskCompletionEffects = {
  documentOperations: Awaited<ReturnType<typeof applyChannelDocumentOperations>>;
  skillImportOperations: Awaited<ReturnType<typeof applySkillImportOperations>>;
  documentRuntimeOutputOperations: Awaited<ReturnType<typeof applyDocumentRuntimeOutputOperations>>;
  feishuLarkCliResultOperations: Awaited<ReturnType<typeof applyFeishuLarkCliResultManifestOperations>>;
  feishuRuntimeDataOperationRequests: Awaited<ReturnType<typeof applyFeishuRuntimeDataOperationRequests>>;
  knowledgeProposalOperations: Awaited<ReturnType<typeof applyKnowledgeProposalOperations>>;
};
type TaskCompletionSnapshot = {
  finalOutputText: string;
  normalizedWorkflowOutput?: Record<string, unknown>;
  effects?: TaskCompletionEffects;
  provider?: string;
  runtimeName?: string;
  sessionId?: string;
  conversationSessionId?: string | null;
  workDir?: string;
};

export function persistManagedTaskUsagesBestEffort(input: {
  usages: CompleteTaskUsage[];
  workspaceId: string;
  taskId: string;
  agentId: string;
  routerSessionId?: string;
  runtimeCredentialId?: string;
  recordUsage?: typeof recordTokenUsageSync;
  enqueueRetry?: typeof enqueueTokenUsageRetrySync;
  onError?: (error: unknown) => void;
}): boolean {
  const recordUsage = input.recordUsage ?? recordTokenUsageSync;
  const enqueueRetry = input.enqueueRetry ?? enqueueTokenUsageRetrySync;
  let allPersisted = true;
  for (const usage of input.usages) {
    if (!(
      input.runtimeCredentialId &&
      usage.runtimeCredentialId === input.runtimeCredentialId &&
      usage.modelId?.trim() &&
      Number.isFinite(usage.inputTokens) &&
      Number.isFinite(usage.outputTokens) &&
      usage.inputTokens >= 0 &&
      usage.outputTokens >= 0 &&
      (usage.inputTokens > 0 || usage.outputTokens > 0)
    )) continue;
    const usageRecord = {
        workspaceId: input.workspaceId,
        taskQueueId: input.taskId,
        agentId: input.agentId,
        modelId: usage.modelId.trim(),
        runtimeCredentialId: usage.runtimeCredentialId,
        routerSessionId: input.routerSessionId,
        gatewayRequestId: usage.gatewayRequestId,
        gatewayUsageId: usage.gatewayUsageId,
        protocol: usage.protocol,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheTokens: usage.cacheTokens,
        requestStartedAt: usage.requestStartedAt,
        requestEndedAt: usage.requestEndedAt,
      };
    try {
      recordUsage(usageRecord);
    } catch (error) {
      allPersisted = false;
      try {
        enqueueRetry(usageRecord, error);
      } catch (retryError) {
        try {
          input.onError?.(retryError);
        } catch {
          // Completion remains successful even if retry diagnostics fail.
        }
        throw new Error("token_usage.durability_unavailable", { cause: retryError });
      }
      try {
        input.onError?.(error);
      } catch {
        // Completion must remain successful even if warning persistence also fails.
      }
    }
  }
  return allPersisted;
}

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
  if (task.status === "committed" || task.status === "completed") {
    const journal = readTaskCommitJournalSync(task.id, task.workspaceId);
    const finalizationPending = task.status === "committed"
      || (journal?.commitState === "preparing" && journal.errorCode === "commit_reconciliation_retrying");
    if (!finalizationPending) {
      return Response.json({ task: { id: task.id, status: task.status }, ignored: true });
    }
    try {
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: task.employeeName,
        commitState: "preparing",
        errorCode: "commit_reconciliation_retrying",
        errorMessage: "Retrying durable business projections.",
      });
      finalizeReconciledTask(task);
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: task.employeeName,
        commitState: "committed",
      });
      return Response.json({ task: { id: task.id, status: "completed" }, recovered: true });
    } catch (error) {
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: task.employeeName,
        commitState: "preparing",
        errorCode: "commit_reconciliation_retrying",
        errorMessage: error instanceof Error ? error.message : String(error),
        incrementAttempt: true,
      });
      return Response.json(
        { error: "Task outputs are durable, but business projections are still being reconciled.", taskId: task.id },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
  }
  if (["failed", "cancelled"].includes(task.status)) {
    return Response.json({ task: { id: task.id, status: task.status }, ignored: true });
  }

  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime || runtime.workspaceId !== auth.workspaceId) {
    return Response.json({ error: `Runtime "${task.runtimeId}" does not exist.` }, { status: 404 });
  }

  const body = (await request.json()) as Partial<CompleteTaskRequest>;
  const usages = [...(Array.isArray(body.usages) ? body.usages : []), ...(body.usage ? [body.usage] : [])];
  if (resolveAgentRuntimeMode() === "remote" && runtime.managedCredentialId) {
    try {
      persistManagedTaskUsagesBestEffort({
        usages,
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentId: task.employeeId,
        routerSessionId: task.routerSessionId,
        runtimeCredentialId: runtime.managedCredentialId,
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Failed to persist managed usage for task ${task.id}: ${message}`);
        },
      });
    } catch {
      return Response.json(
        { error: "Usage attribution could not be persisted; retry task completion." },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
  }
  const payload = parseTaskPayload(task);
  const agentName = payload.assignee ?? task.agentId;
  const workspaceState = readWorkspaceStateSync(task.workspaceId);
  const providerSupportsReusableSession = runtime.provider !== "hermes";
  const conversationSessionId = providerSupportsReusableSession ? body.sessionId : null;
  const effectiveChannelName =
    payload.channelName
      ?? (payload.contactId ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name : undefined);
  const fallbackOutput = body.outputText?.trim() ?? "";
  const stagingDir = getDaemonTaskOutputStagingDir(task.id, task.workspaceId);
  let persistedAttachments: Awaited<ReturnType<typeof loadTaskOutputEnvelope>>["attachments"] = [];
  let taskCompletionCommitted = false;
  let preserveOutputStaging = false;
  let taskCommitBoundaryCrossed = task.status === "preparing_commit";
  let completionEffectsCheckpointed = false;

  // EAD-005 write-lease gate: validate the claim-time binding generation BEFORE
  // any side effect (document/skill/feishu operations, message writes, output
  // promotion). A stale runtime must not be able to commit text or side effects
  // after the employee was rebound to a newer generation. Tasks without a claim
  // lease are refused outright rather than falling back to a late sample.
  if (typeof task.bindingGeneration !== "number") {
    return Response.json(
      { error: "Task has no claim-time binding generation; refusing to complete." },
      { status: 409 },
    );
  }
  assertEmployeeBindingGenerationSync(agentName, task.bindingGeneration, task.workspaceId);
  if (body.outputBundle && !["preparing_commit", "committed"].includes(task.status)) {
    try {
      materializeOutputBundleToStaging(task.id, task.workspaceId, body.outputBundle);
    } catch (error) {
      clearDaemonTaskOutputStaging(task.id, task.workspaceId);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  try {
    const replaySnapshot = task.status === "preparing_commit"
      ? readTaskCompletionEffectsSnapshot<TaskCompletionSnapshot>(task.id, task.workspaceId)
      : null;
    const replaySafeSnapshot = replaySnapshot?.effects ? replaySnapshot : null;
    completionEffectsCheckpointed = Boolean(replaySafeSnapshot);
    const outputEnvelope = loadTaskOutputEnvelope(
      stagingDir,
      replaySafeSnapshot?.finalOutputText ?? fallbackOutput,
      task.workspaceId,
      {
        attachmentNamespace: task.id,
      },
    );
    const finalOutputText = replaySafeSnapshot?.finalOutputText ?? outputEnvelope.text;
    persistedAttachments = outputEnvelope.attachments;
    const normalizedWorkflowOutput = replaySafeSnapshot
      ? replaySafeSnapshot.normalizedWorkflowOutput
      : prepareWorkflowTaskOutputSync({
          workspaceId: task.workspaceId,
          taskQueueId: task.id,
          outputText: finalOutputText,
          structuredOutput: body.structuredOutput,
        });
    const commitBoundary = withTransaction(getDatabase(), () => (
      beginWorkflowTaskCommitSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        completionEffectsCheckpointed: Boolean(replaySafeSnapshot),
      })
    ));
    if (commitBoundary.ignored) {
      preserveOutputStaging = ["preparing_commit", "committed", "completed"].includes(commitBoundary.taskStatus);
      if (!preserveOutputStaging && persistedAttachments.length > 0) discardTaskOutputAttachments(persistedAttachments);
      return Response.json({ task: { id: task.id, status: commitBoundary.taskStatus }, ignored: true });
    }
    taskCommitBoundaryCrossed = true;
    const completionSnapshot = commitBoundary.resumed
      ? replaySnapshot ?? readTaskCompletionEffectsSnapshot<TaskCompletionSnapshot>(task.id, task.workspaceId)
      : {
          finalOutputText,
          ...(normalizedWorkflowOutput ? { normalizedWorkflowOutput } : {}),
          provider: runtime.provider,
          runtimeName: runtime.name,
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          conversationSessionId,
          ...(body.workDir ? { workDir: body.workDir } : {}),
        };
    if (commitBoundary.resumed && !completionSnapshot?.effects) {
      throw new Error("workflow_completion_effect_uncertain");
    }
    if (!completionSnapshot) throw new Error("workflow_commit_snapshot_missing");
    completionEffectsCheckpointed = Boolean(completionSnapshot.effects);
    if (completionEffectsCheckpointed) {
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "workflow_completion_effects_checkpointed",
      });
    }
    if (!commitBoundary.resumed) {
      writeTaskCompletionEffectsSnapshot(task.id, task.workspaceId, completionSnapshot);
    }
    let effects = completionSnapshot.effects ?? null;
    if (!effects) {
      const feishuLarkCliResourceGrants = listFeishuLarkCliResourceGrantsForChannelSync({
        workspaceId: task.workspaceId,
        channelName: effectiveChannelName,
      });
      effects = {
        documentOperations: effectiveChannelName
          ? applyChannelDocumentOperations(stagingDir, {
              channelName: effectiveChannelName,
              sourceMessageId: payload.sourceMessageId,
              sourceTaskQueueId: task.id,
              actorName: payload.assignee ?? task.agentId,
              workspaceId: task.workspaceId,
            })
          : { warnings: [], documentUpdates: [] },
        skillImportOperations: await applySkillImportOperations(stagingDir, {
          workspaceId: task.workspaceId,
          agentName: payload.assignee ?? task.agentId,
        }),
        documentRuntimeOutputOperations: applyDocumentRuntimeOutputOperations({
          workDir: stagingDir,
          workspaceId: task.workspaceId,
          actorName: payload.assignee ?? task.agentId,
          sourceTaskQueueId: task.id,
          sourceChannelName: effectiveChannelName,
          requestedByUserId: task.requestedByUserId,
          requestedByDisplayName: task.requestedByDisplayName,
        }),
        feishuLarkCliResultOperations: applyFeishuLarkCliResultManifestOperations({
          workDir: stagingDir,
          workspaceId: task.workspaceId,
          actorName: payload.assignee ?? task.agentId,
          resourceGrants: feishuLarkCliResourceGrants,
        }),
        feishuRuntimeDataOperationRequests: await applyFeishuRuntimeDataOperationRequests({
          workDir: stagingDir,
          workspaceId: task.workspaceId,
          actorName: payload.assignee ?? task.agentId,
          sourceTaskQueueId: task.id,
          sourceChannelName: effectiveChannelName,
          sourceDofeAgentMessageId: payload.sourceMessageId,
          resourceGrants: feishuLarkCliResourceGrants,
        }),
        knowledgeProposalOperations: applyKnowledgeProposalOperations({
          workDir: stagingDir,
          workspaceId: task.workspaceId,
          actorName: payload.assignee ?? task.agentId,
          sourceTaskQueueId: task.id,
          sourceChannelName: effectiveChannelName,
        }),
      };
      writeTaskCompletionEffectsSnapshot(task.id, task.workspaceId, { ...completionSnapshot, effects });
      completionEffectsCheckpointed = true;
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "workflow_completion_effects_checkpointed",
      });
    }
    const {
      documentOperations,
      skillImportOperations,
      documentRuntimeOutputOperations,
      feishuLarkCliResultOperations,
      feishuRuntimeDataOperationRequests,
      knowledgeProposalOperations,
    } = effects;
    if (!commitBoundary.resumed) {
      appendTaskMessageSync({ taskId: task.id, type: "text", content: finalOutputText });
      for (const content of [
        ...outputEnvelope.warnings,
        ...skillImportOperations.statusMessages,
        ...skillImportOperations.warnings,
        ...documentRuntimeOutputOperations.statusMessages,
        ...feishuLarkCliResultOperations.statusMessages,
        ...feishuLarkCliResultOperations.warnings,
        ...feishuRuntimeDataOperationRequests.statusMessages,
        ...feishuRuntimeDataOperationRequests.warnings,
        ...knowledgeProposalOperations.statusMessages,
        ...documentOperations.warnings,
      ]) {
        appendTaskMessageSync({ taskId: task.id, type: "status", content });
      }
    }

    // Durability commit phases (EAD §7): preparing → promote to the employee's
    // persistent workspace → committed. A promotion failure keeps the task in
    // `preparing_commit` and returns a retryable 503: the daemon retries and the
    // journal is the reconciliation source. The task is NOT completed — the
    // user must never see "success" for an uncommitted result (design §7).
    // Lease generation is the one captured at claim time (already asserted above
    // before any side effects).
    const bindingGeneration = task.bindingGeneration;
    let promotionError: string | undefined;
    try {
      let workspaceRevisionId: string | undefined;
      let committedArtifactIds: string[] = [];
      const workDirFiles = readStagedWorkDirFiles(task.id, task.workspaceId);
      const deletedPaths = readStagedWorkDirDeletedPaths(task.id, task.workspaceId);
      const outputs = [
        ...workDirFiles,
        ...persistedAttachments.map((attachment) => ({
          path: attachment.fileName,
          bytes: readWorkspaceAttachmentBytesSync(attachment),
          mediaType: attachment.mediaType,
        })),
      ];
      if (outputs.length > 0 || deletedPaths.length > 0) {
        const promoted = promoteTaskOutputsToWorkspaceSync({
          workspaceId: task.workspaceId,
          taskId: task.id,
          employeeName: agentName,
          outputs,
          deletedPaths,
          publishArtifacts: true,
          expectedBindingGeneration: bindingGeneration,
        });
        workspaceRevisionId = promoted.revision.id;
        committedArtifactIds = promoted.artifactIds;
      }
      markTaskCommittedSync({
        taskId: task.id,
        employeeName: agentName,
        workspaceRevisionId,
        artifactIds: committedArtifactIds,
      });
    } catch (error) {
      promotionError = error instanceof Error ? error.message : String(error);
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "workspace_promotion_failed",
        errorMessage: promotionError,
      });
    }

    if (promotionError) {
      preserveOutputStaging = true;
      return Response.json(
        {
          error: `Task outputs were received but not durably committed (${promotionError}). ` +
            "Retrying the complete call will promote them and finish the task.",
          commitState: "preparing",
          taskId: task.id,
        },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }

    const completion = withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        allowPreparingCommit: true,
        allowCommitted: true,
      });
      if (fence.ignored) return { applied: false, status: fence.taskStatus ?? task.status };
      completeCommittedTaskSync({
        taskId: task.id,
        resultJson: {
          provider: runtime.provider,
          output: finalOutputText,
          attachments: outputEnvelope.attachments,
          skillImports: skillImportOperations.imports,
          documentUpdates: documentOperations.documentUpdates,
          feishuLarkCliDataOperationRunIds: feishuLarkCliResultOperations.operationRunIds,
          feishuRuntimeDataOperationRunIds: feishuRuntimeDataOperationRequests.operationRunIds,
          feishuRuntimeDataOperationApprovalIds: feishuRuntimeDataOperationRequests.approvalIds,
          documentPermissionRequests: documentRuntimeOutputOperations.permissionRequests,
          knowledgeProposals: knowledgeProposalOperations.knowledgeProposals,
        },
        sessionId: body.sessionId,
        workDir: body.workDir,
      });
      completeWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        outputText: finalOutputText,
        structuredOutput: body.structuredOutput,
        normalizedOutput: normalizedWorkflowOutput,
        artifactManifest: outputEnvelope.attachments,
      });
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "commit_reconciliation_retrying",
        errorMessage: "Durable outputs are committed; business projections are pending.",
      });
      return { applied: true, status: "completed" };
    });
    if (!completion.applied) {
      if (persistedAttachments.length > 0) discardTaskOutputAttachments(persistedAttachments);
      return Response.json({ task: { id: task.id, status: completion.status }, ignored: true });
    }
    taskCompletionCommitted = true;

    if (payload.taskId) {
      updateTaskStatusSync(payload.taskId, "done", task.workspaceId);
    }
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(
        completeChannelDocumentRunStepSync({
          queuedTaskId: task.id,
          documentUpdates: documentOperations.documentUpdates,
          warningText: documentOperations.warnings[0],
        }, task.workspaceId),
        task.workspaceId,
      );
    }
    if (effectiveChannelName && payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        pendingSpeaker: payload.assignee ?? task.agentId,
        speaker: payload.assignee ?? runtime.name,
        summary: finalOutputText,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: conversationSessionId ?? undefined,
        workDir: body.workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of replyResult.created ? enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        text: finalOutputText,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [payload.assignee ?? task.agentId],
          message: finalOutputText,
          taskId: task.id,
        },
      }) : []) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: payload.assignee ?? task.agentId,
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: null,
      }, task.workspaceId);
      if (payload.contactId) {
        upsertDirectConversationStateSync({
          contactId: payload.contactId,
          sessionId: conversationSessionId,
          workDir: body.workDir,
        }, task.workspaceId);
      }
    } else if (payload.contactId) {
      writeConversationExecutionWorkspaceStateSync({
        channelName: effectiveChannelName ?? payload.channel ?? payload.contactId,
        agentId: payload.contactId,
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: null,
      }, task.workspaceId);
      upsertDirectConversationStateSync({
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
      }, task.workspaceId);
    } else if (payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        speaker: runtime.name,
        summary: finalOutputText,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: conversationSessionId ?? undefined,
        workDir: body.workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of replyResult.created ? enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        text: finalOutputText,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [payload.assignee ?? task.agentId],
          message: finalOutputText,
          taskId: task.id,
        },
      }) : []) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: payload.assignee ?? task.agentId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: null,
      }, task.workspaceId);
    }
    tryContinueAutoContinuation({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: conversationSessionId ?? undefined,
      workDir: body.workDir,
    });
    upsertTaskCommitJournalSync({
      taskId: task.id,
      workspaceId: task.workspaceId,
      employeeName: agentName,
      commitState: "committed",
    });

    return Response.json({
      task: {
        id: task.id,
        status: "completed",
        output: finalOutputText,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (taskCompletionCommitted) {
      preserveOutputStaging = true;
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "commit_reconciliation_retrying",
        errorMessage: message,
      });
      return Response.json(
        { error: "Task completed, but its business projections are still being reconciled.", taskId: task.id },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
    if (taskCommitBoundaryCrossed && completionEffectsCheckpointed) {
      preserveOutputStaging = true;
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "workflow_completion_effects_checkpointed",
        errorMessage: message,
      });
      return Response.json(
        { error: "Task effects were checkpointed and completion will be retried safely.", taskId: task.id },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
    const preserveUncertainEffects = taskCommitBoundaryCrossed && !completionEffectsCheckpointed;
    if (preserveUncertainEffects) preserveOutputStaging = true;
    if (!preserveUncertainEffects && persistedAttachments.length > 0) {
      discardTaskOutputAttachments(persistedAttachments);
    }
    const providerError = error instanceof AgentDocumentPermissionError
      ? {
          code: error.code,
          category: "provider" as const,
          rawProviderMessage: error.message,
        }
      : undefined;
    const workflowErrorCode = resolveWorkflowCompletionFailureCode({
      commitBoundaryCrossed: taskCommitBoundaryCrossed,
      effectsCheckpointed: completionEffectsCheckpointed,
      errorCode: getWorkflowCompletionErrorCode(error),
    });
    const failure = withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        allowPreparingCommit: true,
      });
      if (fence.ignored) return { applied: false, status: fence.taskStatus ?? task.status };
      failQueuedTaskSync({
        taskId: task.id,
        errorText: message,
        errorCode: workflowErrorCode ?? providerError?.code,
        errorCategory: providerError?.category,
        rawProviderMessage: providerError?.rawProviderMessage,
        sessionId: body.sessionId,
        workDir: body.workDir,
      });
      failWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        errorCode: workflowErrorCode ?? providerError?.code,
        errorText: message,
      });
      if (taskCommitBoundaryCrossed) {
        upsertTaskCommitJournalSync({
          taskId: task.id,
          workspaceId: task.workspaceId,
          commitState: "rolled_back",
          errorCode: workflowErrorCode ?? "workflow_completion_failed",
          errorMessage: message,
        });
      }
      return { applied: true, status: "failed" };
    });
    if (!failure.applied) {
      return Response.json({ task: { id: task.id, status: failure.status }, ignored: true });
    }
    appendTaskMessageSync({
      taskId: task.id,
      type: "error",
      content: message,
    });

    if (payload.taskId) {
      updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    }
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(
        failChannelDocumentRunStepSync({
          queuedTaskId: task.id,
          errorText: message,
        }, task.workspaceId),
        task.workspaceId,
      );
    }
    if (effectiveChannelName && payload.channel) {
      const failureSummary = formatConversationFailureSummary({
        agentName: payload.assignee ?? task.agentId,
        channelName: payload.channel,
        errorText: message,
        isDirectConversation: Boolean(payload.contactId),
      });
      replacePendingChannelMessageSync({
        channel: payload.channel,
        pendingSpeaker: payload.assignee ?? task.agentId,
        pendingTaskId: task.id,
        speaker: "系统提示",
        role: "agent",
        summary: failureSummary,
        status: "error",
      }, task.workspaceId);
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        text: failureSummary,
        sourceDofeAgentMessageId: payload.sourceMessageId,
      })) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: payload.assignee ?? task.agentId,
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
      if (payload.contactId) {
        upsertDirectConversationStateSync({
          contactId: payload.contactId,
          sessionId: conversationSessionId,
          workDir: body.workDir,
        }, task.workspaceId);
      }
    } else if (payload.contactId) {
      writeConversationExecutionWorkspaceStateSync({
        channelName: effectiveChannelName ?? payload.channel ?? payload.contactId,
        agentId: payload.contactId,
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
      upsertDirectConversationStateSync({
        contactId: payload.contactId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
      }, task.workspaceId);
    } else if (payload.channel) {
      const failureSummary = formatTaskFailureSummary({
        title: payload.title || task.id,
        errorText: message,
      });
      postMessageSync({
        channel: payload.channel,
        speaker: "系统提示",
        role: "agent",
        summary: failureSummary,
        status: "error",
      }, task.workspaceId);
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        text: failureSummary,
        sourceDofeAgentMessageId: payload.sourceMessageId,
      })) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: payload.assignee ?? task.agentId,
        sessionId: conversationSessionId,
        workDir: body.workDir,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
    }
    tryContinueAutoContinuation({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: conversationSessionId ?? undefined,
      workDir: body.workDir,
    });

    return Response.json({ error: message }, { status: 500 });
  } finally {
    if (!preserveOutputStaging) clearDaemonTaskOutputStaging(task.id, task.workspaceId);
  }
}

function enqueueFeishuReplyOutboxBestEffort(input: {
  workspaceId: string;
  channelName: string;
  text: string;
  attachments?: MessageAttachment[];
  dofeAgentMessageId?: string;
  sourceDofeAgentMessageId?: string;
  statusCard?: {
    status: FeishuAgentStatusCardStatus;
    agentNames: string[];
    message?: string;
    taskId?: string;
  };
}): string[] {
  try {
    const statusCardItems = input.statusCard
      ? queueFeishuAgentStatusCardOutboxSync({
          workspaceId: input.workspaceId,
          channelName: input.channelName,
          status: input.statusCard.status,
          agentNames: input.statusCard.agentNames,
          message: input.statusCard.message,
          taskId: input.statusCard.taskId,
          dofeAgentMessageId: input.dofeAgentMessageId,
          sourceDofeAgentMessageId: input.sourceDofeAgentMessageId,
        })
      : [];
    const replyOutboxItems = queueFeishuChannelReplyOutboxSync(input);
    const queuedCount = statusCardItems.length + replyOutboxItems.length;
    return queuedCount > 0 ? [`Feishu outbound queued: ${queuedCount} message(s).`] : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Feishu outbound enqueue failed: ${message}`];
  }
}

function tryContinueAutoContinuation(input: {
  taskId: string;
  workspaceId: string;
  sessionId?: string;
  workDir?: string;
}): void {
  try {
    continueAutoContinuationAfterTaskSync(input);
  } catch {
    // Completion reporting should not fail if the best-effort continuation enqueue fails.
  }
}
