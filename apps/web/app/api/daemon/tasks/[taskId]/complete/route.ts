import {
  appendTaskMessageSync,
  assertEmployeeBindingGenerationSync,
  completeCommittedTaskSync,
  getDatabase,
  failQueuedTaskSync,
  enqueueTokenUsageRetrySync,
  markTaskCommittedSync,
  markTaskPreparingCommitSync,
  readAgentRuntimeSync,
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
  promoteTaskOutputsToWorkspaceSync,
  queueFeishuAgentStatusCardOutboxSync,
  queueFeishuChannelReplyOutboxSync,
  readWorkspaceAttachmentBytesSync,
  readWorkspaceStateSync,
  replacePendingChannelMessageSync,
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
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import {
  clearDaemonTaskOutputStaging,
  getDaemonTaskOutputStagingDir,
  materializeOutputBundleToStaging,
  readStagedWorkDirDeletedPaths,
  readStagedWorkDirFiles,
} from "../../../_lib/output-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CompleteTaskUsage = NonNullable<CompleteTaskRequest["usages"]>[number];

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
  if (task.status === "cancelled") {
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

  if (body.outputBundle) {
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
    const documentOperations = effectiveChannelName
      ? applyChannelDocumentOperations(stagingDir, {
          channelName: effectiveChannelName,
          sourceMessageId: payload.sourceMessageId,
          sourceTaskQueueId: task.id,
          actorName: payload.assignee ?? task.agentId,
          workspaceId: task.workspaceId,
        })
      : { warnings: [] as string[], documentUpdates: [] as Array<{ documentId: string; documentVersionId: string }> };
    const skillImportOperations = await applySkillImportOperations(stagingDir, {
      workspaceId: task.workspaceId,
      agentName: payload.assignee ?? task.agentId,
    });
    const documentRuntimeOutputOperations = applyDocumentRuntimeOutputOperations({
      workDir: stagingDir,
      workspaceId: task.workspaceId,
      actorName: payload.assignee ?? task.agentId,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      requestedByUserId: task.requestedByUserId,
      requestedByDisplayName: task.requestedByDisplayName,
    });
    const feishuLarkCliResourceGrants = listFeishuLarkCliResourceGrantsForChannelSync({
      workspaceId: task.workspaceId,
      channelName: effectiveChannelName,
    });
    const feishuLarkCliResultOperations = applyFeishuLarkCliResultManifestOperations({
      workDir: stagingDir,
      workspaceId: task.workspaceId,
      actorName: payload.assignee ?? task.agentId,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const feishuRuntimeDataOperationRequests = await applyFeishuRuntimeDataOperationRequests({
      workDir: stagingDir,
      workspaceId: task.workspaceId,
      actorName: payload.assignee ?? task.agentId,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      sourceDofeAgentMessageId: payload.sourceMessageId,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const knowledgeProposalOperations = applyKnowledgeProposalOperations({
      workDir: stagingDir,
      workspaceId: task.workspaceId,
      actorName: payload.assignee ?? task.agentId,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
    });
    const outputEnvelope = loadTaskOutputEnvelope(stagingDir, fallbackOutput, task.workspaceId);
    const finalOutputText = outputEnvelope.text;
    persistedAttachments = outputEnvelope.attachments;

    appendTaskMessageSync({
      taskId: task.id,
      type: "text",
      content: finalOutputText,
    });
    for (const warning of outputEnvelope.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of skillImportOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of skillImportOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of documentRuntimeOutputOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const message of feishuLarkCliResultOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of feishuLarkCliResultOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of feishuRuntimeDataOperationRequests.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of feishuRuntimeDataOperationRequests.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of knowledgeProposalOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of documentOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
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
      markTaskPreparingCommitSync(task.id);
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

    withTransaction(getDatabase(), () => {
      lockWorkflowRunForTaskIfLinkedSync({ workspaceId: task.workspaceId, taskQueueId: task.id });
      completeCommittedTaskSync({
        taskId: task.id,
        resultJson: {
          provider: runtime.provider,
          output: finalOutputText,
          attachments: outputEnvelope.attachments.map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            mediaType: attachment.mediaType,
            kind: attachment.kind,
            sizeBytes: attachment.sizeBytes,
          })),
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
        artifactManifest: outputEnvelope.attachments,
      });
    });

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
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
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
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
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
        lastError: null,
      }, task.workspaceId);
    }
    tryContinueAutoContinuation({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: conversationSessionId ?? undefined,
      workDir: body.workDir,
    });

    return Response.json({
      task: {
        id: task.id,
        status: "completed",
        output: finalOutputText,
      },
    });
  } catch (error) {
    if (persistedAttachments.length > 0) {
      discardTaskOutputAttachments(persistedAttachments);
    }
    const message = error instanceof Error ? error.message : String(error);
    appendTaskMessageSync({
      taskId: task.id,
      type: "error",
      content: message,
    });
    const providerError = error instanceof AgentDocumentPermissionError
      ? {
          code: error.code,
          category: "provider" as const,
          rawProviderMessage: error.message,
        }
      : undefined;
    const workflowErrorCode = getWorkflowCompletionErrorCode(error);
    withTransaction(getDatabase(), () => {
      lockWorkflowRunForTaskIfLinkedSync({ workspaceId: task.workspaceId, taskQueueId: task.id });
      failQueuedTaskSync({
        taskId: task.id,
        errorText: message,
        errorCode: providerError?.code ?? workflowErrorCode,
        errorCategory: providerError?.category,
        rawProviderMessage: providerError?.rawProviderMessage,
        sessionId: body.sessionId,
        workDir: body.workDir,
      });
      failWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        errorCode: providerError?.code ?? workflowErrorCode,
        errorText: message,
      });
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
    clearDaemonTaskOutputStaging(task.id, task.workspaceId);
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
