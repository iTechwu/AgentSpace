// daemon CLI 的队列任务轮询与执行（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { applyChannelDocumentOperations } from "../../lib/channel-documents.ts";
import { HttpDaemonClient } from "../../lib/daemon-client.ts";
import { parseTaskPayload, prepareDaemonTaskContext } from "../../lib/daemon-task-context.ts";
import { clearTaskOutputArtifacts, loadTaskOutputEnvelope } from "../../lib/daemon-task-output.ts";
import { applySkillImportOperations, prepareSkillImportOperationArtifacts } from "../../lib/skill-imports.ts";
import { enqueueTaskCompletionFeishuOutbox } from "../../lib/task-completion-outbox.ts";
import { buildTaskCompletionTokenUsage } from "../../lib/task-completion-token-usage.ts";
import { appendTaskMessageSync, assertEmployeeBindingGenerationSync, chooseProviderSessionForTaskSync, claimNextQueuedTaskForRuntimeSync, completeCommittedTaskSync, failQueuedTaskSync, getDaemonChannelWorkDirPath, getDatabase, getWorkspaceDaemonRemoteStagingDirPath, markTaskCommittedSync, readDaemonSnapshotSync, readQueuedTaskSync, recordTokenUsageSync, upsertTaskCommitJournalSync, withTransaction } from "@dofe-agent/db";
import type { AgentRuntimeRecord, QueuedTaskRecord } from "@dofe-agent/db";
import type { RuntimeToolCapability } from "@dofe-agent/domain";
import type { ActiveEmployee, MessageAttachment } from "@dofe-agent/domain/workspace";
import { AgentDocumentPermissionError, resolveAgentDocumentContextSync } from "@dofe-agent/services/operations";
import { applyFeishuLarkCliResultManifestOperations, applyFeishuRuntimeDataOperationRequests, listFeishuLarkCliResourceGrantsForChannelSync } from "@dofe-agent/services/integrations";
import { beginWorkflowTaskCommitSync, completeWorkflowTaskIfLinkedSync, failWorkflowTaskIfLinkedSync, lockWorkflowRunForTaskIfLinkedSync, prepareWorkflowTaskOutputSync, resolveWorkflowCompletionFailureCode, startQueuedTaskWithWorkflowSync } from "@dofe-agent/services/workflows";
import { buildContactAgentContext, deleteWorkspaceAttachmentsSync, readWorkspaceAttachmentBytesSync } from "@dofe-agent/services/content";
import { buildSkillRunnerEntrypointsForSnapshotSync } from "@dofe-agent/services/skills";
import { checkAllBudgetsForAgentSync } from "@dofe-agent/services/finance";
import { completeAgentChannelReplySync, formatConversationFailureSummary, formatTaskFailureSummary, postMessageSync, replacePendingChannelMessageSync } from "@dofe-agent/services/messaging";
import { completeChannelDocumentRunStepSync, failChannelDocumentRunStepSync, markChannelDocumentRunStepRunningSync } from "@dofe-agent/services/documents";
import { promoteTaskOutputsToWorkspaceSync } from "@dofe-agent/services/employees";
import { readWorkspaceStateSync, writeConversationExecutionWorkspaceStateSync, writeWorkspaceStateSync } from "@dofe-agent/services/workspace";
import { resolveAgentRuntimeMode } from "@dofe-agent/services/runtime";
import { resolveCompatibleDirectChannelRecord, upsertDirectConversationStateSync } from "@dofe-agent/services/channels";
import { resolveEffectiveModelForTaskAsync } from "@dofe-agent/services/models";
import { updateTaskStatusSync } from "@dofe-agent/services/tasks";
import { applyDocumentRuntimeOutputOperations, applyKnowledgeProposalOperations, buildDocumentRuntimeToolCapabilities, buildSkillDependencyTaskEnvironment, collectRuntimeOutputBundle, collectWorkDirChanges, materializeInputBundle, normalizeProviderTaskErrorCategory, partitionSkillEnvironment, readEmployeeHeadManifestSync, readProviderTaskFailureMetadata, selectSkillDependencyEnvironments, startSkillRunnerBroker } from "dofe-agent-daemon";
import type { SkillRunnerBroker } from "dofe-agent-daemon";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDaemonStateDir } from "./lifecycle.ts";
import { buildRouterSessionPromptContext, resolveModelId, runProviderTask, runProviderTaskWithModel } from "./runtime.ts";
import { getWorkspaceRemoteTaskWorkDir, persistLocalCompletionRecoverySnapshot, resolveConversationThreadId, resolveWorkspaceTaskWorkDir, sameValue, toQueuedTaskRecord } from "./utils.ts";
import type { DaemonConfig } from "./config.ts";

export async function pollQueuedTasks(config: DaemonConfig, activeRuntimes: Set<string>): Promise<void> {
  const snapshot = readDaemonSnapshotSync(config.daemonKey);
  for (const runtime of snapshot.runtimes) {
    if (runtime.status !== "online" || activeRuntimes.has(runtime.id)) {
      continue;
    }

    const queuedTask = claimNextQueuedTaskForRuntimeSync(runtime.id, runtime.workspaceId);
    if (!queuedTask) {
      continue;
    }

    activeRuntimes.add(runtime.id);
    void executeQueuedTask(runtime, queuedTask)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Task ${queuedTask.id} crashed: ${message}`);
      })
      .finally(() => {
        activeRuntimes.delete(runtime.id);
      });
  }
}
export async function pollRemoteTasks(
  client: HttpDaemonClient,
  runtimes: AgentRuntimeRecord[],
  activeRuntimes: Set<string>,
): Promise<void> {
  for (const runtime of runtimes) {
    if (activeRuntimes.has(runtime.id)) {
      continue;
    }

    const claimed = await client.claimTask(runtime.id);
    if (!claimed.task) {
      continue;
    }

    activeRuntimes.add(runtime.id);
    void executeRemoteQueuedTask(client, runtime, toQueuedTaskRecord(claimed.task))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Remote task ${claimed.task?.id ?? "unknown"} crashed: ${message}`);
      })
      .finally(() => {
        activeRuntimes.delete(runtime.id);
      });
  }
}
export interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  modelId?: string;
  gatewayRequestId?: string;
}
export interface ProviderTaskEvent {
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
}
export interface ProviderTaskOptions {
  sessionId?: string;
  modelId?: string;
  contextEnv?: Record<string, string>;
  /** Keys in `contextEnv` injected from per-employee Skill configuration; always redacted from logs. */
  skillEnvKeys?: string[];
  taskTimeoutMs?: number;
  runtimeToolCapabilities?: RuntimeToolCapability[];
  onEvent?: (event: ProviderTaskEvent) => void;
}
export async function executeRemoteQueuedTask(
  client: HttpDaemonClient,
  runtime: AgentRuntimeRecord,
  task: QueuedTaskRecord,
): Promise<void> {
  const payload = parseTaskPayload(task);
  const channelThreadId = resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  });
  const workDir = channelThreadId
    ? getDaemonChannelWorkDirPath(ensureDaemonStateDir(), {
      workspaceId: task.workspaceId,
      threadId: channelThreadId,
      agentId: task.agentId,
    })
    : getWorkspaceRemoteTaskWorkDir(task.workspaceId, task.id);
  const isPersistentConversationWorkspace = Boolean(channelThreadId);
  if (!isPersistentConversationWorkspace) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });
  let skillRunner: SkillRunnerBroker | undefined;

  try {
    await client.startTask(task.id);
    const bundle = await client.getInputBundle(task.id);
    if (bundle.metadata.skillEnvConflicts && bundle.metadata.skillEnvConflicts.length > 0) {
      throw new Error(
        `Skill environment variable conflicts detected: ${bundle.metadata.skillEnvConflicts.join(", ")}. ` +
          "Resolve by using the same value across skills or uninstalling conflicting skills.",
      );
    }
    materializeInputBundle(workDir, bundle);
    const runnerEntrypoints = bundle.metadata.skillRunnerEntrypoints ?? [];
    const skillEnvironment = partitionSkillEnvironment(bundle.metadata.skillEnv, runnerEntrypoints);
    skillRunner = await startSkillRunnerBroker({
      stateDir: ensureDaemonStateDir(),
      workspaceId: task.workspaceId,
      workDir,
      entrypoints: runnerEntrypoints,
      dependencyEnvironments: bundle.metadata.skillDependencyEnvironments,
      skillEnv: skillEnvironment.runnerEnv,
    });
    const skillDependencyEnv = buildSkillDependencyTaskEnvironment({
      stateDir: ensureDaemonStateDir(),
      workspaceId: task.workspaceId,
      environments: bundle.metadata.skillDependencyEnvironments ?? [],
      baseEnv: { ...process.env, ...skillEnvironment.providerEnv },
    });

    const result = await runProviderTask(
      runtime,
      bundle.prompt,
      workDir,
      {
        sessionId: (bundle.metadata.routerSession?.providerSessionId ?? payload.channelSessionId?.trim()) || undefined,
        skillEnvKeys: Object.keys(skillEnvironment.providerEnv),
        contextEnv: {
          ...skillEnvironment.providerEnv,
          ...skillDependencyEnv,
          DOFE_AGENT_CONTEXT_AGENT_NAME: payload.assignee ?? task.agentId,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
        },
        runtimeToolCapabilities: [
          ...(bundle.metadata.runtimeToolCapabilities?.capabilities ?? []),
          ...skillRunner.capabilities,
        ],
        onEvent: (event) => {
          void client.reportMessages(task.id, {
            messages: [
              {
                type: event.type,
              content: event.content,
              tool: event.tool,
              inputJson: event.inputJson,
              output: event.output,
            },
          ],
            }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Failed to report remote task message for ${task.id}: ${message}`);
            });
        },
      },
    );

    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    for (const warning of preparedSkillImports.warnings) {
      await client.reportMessages(task.id, { messages: [{ type: "status", content: warning }] }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to report skill import warning for ${task.id}: ${message}`);
      });
    }

    const outputBundle = collectRuntimeOutputBundle(workDir);
    if (outputBundle) {
      await client.uploadOutputBundle(task.id, outputBundle);
    }
    await client.completeTask(task.id, {
      outputText: result.output,
      sessionId: result.sessionId,
      workDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError ?? (
      error instanceof AgentDocumentPermissionError
        ? {
            provider: runtime.provider,
            code: error.code,
            category: "provider" as const,
            message,
            rawProviderMessage: error.message,
          }
        : undefined
    );
    await client.failTask(task.id, {
      errorText: message,
      runtimeCredentialId: runtime.managedCredentialId,
      errorCode: providerError?.code,
      errorCategory: normalizeProviderTaskErrorCategory(providerError?.category),
      provider: providerError?.provider,
      rawProviderMessage: providerError?.rawProviderMessage,
      sessionId: failureMetadata?.sessionId,
      workDir: failureMetadata?.workDir ?? workDir,
    });
  } finally {
    await skillRunner?.close();
    clearTaskOutputArtifacts(workDir);
    if (!isPersistentConversationWorkspace) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
export async function executeQueuedTask(runtime: AgentRuntimeRecord, queuedTask: QueuedTaskRecord): Promise<void> {
  try {
    await executeQueuedTaskCore(runtime, queuedTask);
  } catch (error) {
    const task = readQueuedTaskSync(queuedTask.id);
    if (!task || !["claimed", "running"].includes(task.status)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const payload = parseTaskPayload(task);
    const failureApplied = withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
      });
      if (fence.ignored) return false;
      failQueuedTaskSync({
        taskId: task.id,
        errorText: message,
        errorCode: "workflow_task_setup_failed",
      });
      failWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        errorCode: "workflow_task_setup_failed",
        errorText: message,
      });
      return true;
    });
    if (!failureApplied) return;
    appendTaskMessageSync({ taskId: task.id, type: "error", content: message });
    if (payload.taskId) updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(failChannelDocumentRunStepSync({
        queuedTaskId: task.id,
        errorText: message,
      }, task.workspaceId), task.workspaceId);
    }
    if (payload.channel) {
      replacePendingChannelMessageSync({
        channel: payload.channel,
        pendingSpeaker: payload.assignee ?? task.agentId,
        pendingTaskId: task.id,
        speaker: "系统提示",
        role: "agent",
        summary: formatConversationFailureSummary({
          agentName: payload.assignee ?? task.agentId,
          channelName: payload.channel,
          errorText: message,
          isDirectConversation: Boolean(payload.contactId),
        }),
        status: "error",
      }, task.workspaceId);
    }
    try {
      const workspaceState = readWorkspaceStateSync(task.workspaceId);
      const compatibleDirectChannelName = payload.contactId && !payload.channelName
        ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name
        : undefined;
      const channelThreadId = resolveConversationThreadId({
        triggerType: task.triggerType,
        payload: {
          channel: payload.channel,
          channelName: payload.channelName ?? compatibleDirectChannelName,
          contactId: payload.contactId,
        },
      });
      const workDir = resolveWorkspaceTaskWorkDir({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentId: task.agentId,
        channelThreadId,
      });
      clearTaskOutputArtifacts(workDir);
      if (!channelThreadId) rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupError) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `清理启动失败上下文时出现警告：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      });
    }
  }
}
export async function executeQueuedTaskCore(runtime: AgentRuntimeRecord, queuedTask: QueuedTaskRecord): Promise<void> {
  const startResult = startQueuedTaskWithWorkflowSync({
    workspaceId: queuedTask.workspaceId,
    taskQueueId: queuedTask.id,
  });
  if (startResult.ignored) return;
  const task = startResult.task;
  writeWorkspaceStateSync(markChannelDocumentRunStepRunningSync(task.id, task.workspaceId), task.workspaceId);
  const payload = parseTaskPayload(task);

  const budgetCheck = checkAllBudgetsForAgentSync(
    payload.assignee ?? task.agentId,
    payload.channelName ?? payload.channel,
    task.workspaceId,
  );
  if (budgetCheck.status === "exceeded" && budgetCheck.action === "pause") {
    const pct = Math.round(budgetCheck.percentUsed * 100);
    const msg = `Budget exceeded (${pct}% of $${budgetCheck.budget.limitUsd.toFixed(2)}). Task paused.`;
    appendTaskMessageSync({ taskId: task.id, type: "status", content: msg });
    withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({ workspaceId: task.workspaceId, taskQueueId: task.id });
      if (fence.ignored) return;
      failQueuedTaskSync({ taskId: task.id, errorText: msg });
      failWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        errorCode: "workflow_budget_exceeded",
        errorText: msg,
      });
    });
    if (payload.taskId) updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    return;
  }
  const workspaceState = readWorkspaceStateSync(task.workspaceId);
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) =>
    sameValue(employee.name, payload.assignee ?? task.agentId),
  );
  const compatibleDirectChannelName =
    payload.contactId && !payload.channelName
      ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name
      : undefined;
  const effectiveChannelName = payload.channelName ?? compatibleDirectChannelName;
  const effectivePayload =
    effectiveChannelName && payload.contactId && !payload.channelName
      ? {
          ...payload,
          channelName: effectiveChannelName,
          channelMessage: payload.channelMessage,
        }
      : payload;
  const contactContext =
    payload.contactId ? buildContactAgentContext(workspaceState, payload.contactId) : undefined;
  const channelThreadId =
    resolveConversationThreadId({
      triggerType: task.triggerType,
      payload: {
        channel: payload.channel,
        channelName: effectiveChannelName,
        contactId: payload.contactId,
      },
    });
  appendTaskMessageSync({
    taskId: task.id,
    type: "status",
    content: `Task started on ${runtime.name}.`,
  });

  if (payload.taskId) {
    updateTaskStatusSync(payload.taskId, "in_progress", task.workspaceId);
  }

  const workDir = resolveWorkspaceTaskWorkDir({
    workspaceId: task.workspaceId,
    taskId: task.id,
    agentId: task.agentId,
    channelThreadId,
  });
  mkdirSync(workDir, { recursive: true });
  const agentName = effectivePayload.assignee ?? task.agentId;
  // EAD-005 write-lease gate: validate the claim-time binding generation before
  // any side effect (task context build, document/skill/feishu operations,
  // output promotion). A stale runtime must not commit after a rebind.
  if (typeof task.bindingGeneration !== "number") {
    throw new Error("Task has no claim-time binding generation; refusing to run.");
  }
  assertEmployeeBindingGenerationSync(agentName, task.bindingGeneration, task.workspaceId);
  const agentDocumentContexts = resolveAgentDocumentContextSync({
    workspaceId: task.workspaceId,
    agentName,
    channelName: effectiveChannelName,
  });
  const feishuLarkCliResourceGrants = listFeishuLarkCliResourceGrantsForChannelSync({
    workspaceId: task.workspaceId,
    channelName: effectiveChannelName,
  });
  const routerSessionContext = buildRouterSessionPromptContext(task);
  const preparedContext = prepareDaemonTaskContext({
    runtime,
    task,
    workDir,
    agentProfile,
    agentDocumentContexts,
    contactContext,
    payloadOverride: effectivePayload,
    routerSessionContext,
    feishuLarkCliResourceGrants,
  });

  if (preparedContext.skillEnvConflicts.length > 0) {
    throw new Error(
      `Skill environment variable conflicts detected: ${preparedContext.skillEnvConflicts.join(", ")}. ` +
        "Resolve by using the same value across skills or uninstalling conflicting skills.",
    );
  }

  if (preparedContext.skillReadinessBlockers.length > 0) {
    throw new Error(
      `Skill requirements not satisfied for this task: ${preparedContext.skillReadinessBlockers.join("; ")}.`,
    );
  }

  const isManagedRemoteRuntime = Boolean(
    runtime.managedCredentialId && resolveAgentRuntimeMode() === "remote",
  );
  const tokenAcc: TokenAccumulator = isManagedRemoteRuntime
    ? {
        inputTokens: 0,
        outputTokens: 0,
        modelId: "",
      }
    : {
        inputTokens: 0,
        outputTokens: 0,
        modelId: resolveModelId(runtime),
      };
  let runtimeCredentialId: string | undefined;
  if (isManagedRemoteRuntime) {
    const resolution = await resolveEffectiveModelForTaskAsync({
      workspaceId: task.workspaceId,
      employeeName: agentName,
      runtimeId: runtime.id,
      routerSessionId: task.routerSessionId,
    });
    tokenAcc.modelId = resolution.modelId;
    runtimeCredentialId = resolution.runtimeCredentialId;
  }
  let persistedOutputAttachments: MessageAttachment[] = [];
  let taskCompletionCommitted = false;
  let taskCommitBoundaryCrossed = false;
  let completionEffectsCheckpointed = false;
  const recoveryStagingDir = getWorkspaceDaemonRemoteStagingDirPath(task.id, task.workspaceId);
  const runnerEntrypoints = buildSkillRunnerEntrypointsForSnapshotSync(preparedContext.skillExecutionSnapshot);
  const skillEnvironment = partitionSkillEnvironment(preparedContext.skillEnv, runnerEntrypoints);
  let skillRunner: SkillRunnerBroker | undefined;
  const skillDependencyEnv = buildSkillDependencyTaskEnvironment({
    stateDir: ensureDaemonStateDir(),
    workspaceId: task.workspaceId,
    environments: selectSkillDependencyEnvironments(preparedContext.skillExecutionSnapshot),
    baseEnv: { ...process.env, ...skillEnvironment.providerEnv },
  });

  try {
    skillRunner = await startSkillRunnerBroker({
      stateDir: ensureDaemonStateDir(),
      workspaceId: task.workspaceId,
      workDir,
      entrypoints: runnerEntrypoints,
      dependencyEnvironments: selectSkillDependencyEnvironments(preparedContext.skillExecutionSnapshot),
      skillEnv: skillEnvironment.runnerEnv,
    });
    const providerSession = chooseProviderSessionForTaskSync({ task });
    const result = await runProviderTaskWithModel(
      runtime,
      preparedContext.prompt,
      workDir,
      tokenAcc.modelId,
      {
        sessionId: providerSession?.providerSessionId ?? effectivePayload.channelSessionId,
        contextEnv: {
          ...skillEnvironment.providerEnv,
          ...skillDependencyEnv,
          DOFE_AGENT_CONTEXT_AGENT_NAME: agentName,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
        },
        skillEnvKeys: Object.keys(skillEnvironment.providerEnv),
        runtimeToolCapabilities: [
          ...buildDocumentRuntimeToolCapabilities(agentDocumentContexts, {
            feishuLarkCliResourceGrants,
          }),
          ...skillRunner.capabilities,
        ],
        onEvent: (event) => {
          appendTaskMessageSync({
            taskId: task.id,
            type: event.type,
            content: event.content,
            tool: event.tool,
            inputJson: event.inputJson,
            output: event.output,
          });
          if (event.type === "usage" && event.inputJson) {
            const u = event.inputJson as { input_tokens?: number; output_tokens?: number; gateway_request_id?: string };
            tokenAcc.inputTokens += u.input_tokens ?? 0;
            tokenAcc.outputTokens += u.output_tokens ?? 0;
            if (u.gateway_request_id && !tokenAcc.gatewayRequestId) {
              tokenAcc.gatewayRequestId = u.gateway_request_id;
            }
          }
        },
      },
    );
    const outputEnvelope = loadTaskOutputEnvelope(workDir, result.output, task.workspaceId, {
      attachmentNamespace: task.id,
    });
    const conversationSessionId = runtime.provider === "hermes" ? null : result.sessionId ?? null;
    persistedOutputAttachments = outputEnvelope.attachments;
    const normalizedWorkflowOutput = prepareWorkflowTaskOutputSync({
      workspaceId: task.workspaceId,
      taskQueueId: task.id,
      outputText: outputEnvelope.text,
    });
    const commitBoundary = withTransaction(getDatabase(), () => (
      beginWorkflowTaskCommitSync({ workspaceId: task.workspaceId, taskQueueId: task.id })
    ));
    if (commitBoundary.ignored) {
      if (!["preparing_commit", "committed", "completed"].includes(commitBoundary.taskStatus)) {
        deleteWorkspaceAttachmentsSync(persistedOutputAttachments);
        persistedOutputAttachments = [];
      }
      return;
    }
    taskCommitBoundaryCrossed = true;
    const documentOperations = channelThreadId
      ? applyChannelDocumentOperations(workDir, {
        channelName: channelThreadId,
        sourceMessageId: effectivePayload.sourceMessageId,
        sourceTaskQueueId: task.id,
          actorName: agentName,
        workspaceId: task.workspaceId,
      })
      : { warnings: [] as string[], documentUpdates: [] as Array<{ documentId: string; documentVersionId: string }> };
    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    const skillImportOperations = await applySkillImportOperations(workDir, {
      workspaceId: task.workspaceId,
      agentName,
    });
    const documentRuntimeOutputOperations = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      requestedByUserId: task.requestedByUserId,
      requestedByDisplayName: task.requestedByDisplayName,
    });
    const feishuLarkCliResultOperations = applyFeishuLarkCliResultManifestOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const feishuRuntimeDataOperationRequests = await applyFeishuRuntimeDataOperationRequests({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      sourceDofeAgentMessageId: effectivePayload.sourceMessageId,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const knowledgeProposalOperations = applyKnowledgeProposalOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
    });
    appendTaskMessageSync({
      taskId: task.id,
      type: "text",
      content: outputEnvelope.text,
    });
    for (const warning of outputEnvelope.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const warning of preparedSkillImports.warnings) {
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
    // `preparing_commit` (result received but NOT durably committed) and the
    // task is NOT completed nor announced — the journal drives reconciliation.
    // The lease generation was captured at claim time.
    const bindingGeneration = task.bindingGeneration;
    const workDirCapture = collectWorkDirChanges(
      workDir,
      readEmployeeHeadManifestSync(task.workspaceId, agentName),
    );
    if (workDirCapture.unsafePaths.length > 0) {
      throw new Error(
        `workdir_capture_unsafe: refused ${workDirCapture.unsafePaths.length} unsafe path(s): ${workDirCapture.unsafePaths.slice(0, 3).join(", ")}`,
      );
    }
    if (workDirCapture.truncated) {
      throw new Error("output_limit_exceeded: workDir capture exceeded its file/size budget and was truncated");
    }
    const completionTokenUsage = buildTaskCompletionTokenUsage({
      taskId: task.id,
      modelId: tokenAcc.modelId,
      inputTokens: tokenAcc.inputTokens,
      outputTokens: tokenAcc.outputTokens,
      gatewayRequestId: tokenAcc.gatewayRequestId,
      providerAccountId: runtime.providerAccountId,
      runtimeCredentialId,
      routerSessionId: task.routerSessionId,
      channelName: payload.channelName ?? payload.channel,
    });
    persistLocalCompletionRecoverySnapshot({
      stagingDir: recoveryStagingDir,
      workDir,
      workDirFiles: workDirCapture.files,
      deletedPaths: workDirCapture.deletedPaths,
      snapshot: {
        finalOutputText: outputEnvelope.text,
        ...(normalizedWorkflowOutput ? { normalizedWorkflowOutput } : {}),
        provider: runtime.provider,
        runtimeName: runtime.name,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        conversationSessionId,
        workDir,
        ...(completionTokenUsage ? { tokenUsage: completionTokenUsage } : {}),
        effects: {
          documentOperations,
          skillImportOperations,
          documentRuntimeOutputOperations,
          feishuLarkCliResultOperations,
          feishuRuntimeDataOperationRequests,
          knowledgeProposalOperations,
        },
      },
    });
    completionEffectsCheckpointed = true;
    upsertTaskCommitJournalSync({
      taskId: task.id,
      workspaceId: task.workspaceId,
      employeeName: agentName,
      commitState: "preparing",
      errorCode: "workflow_completion_effects_checkpointed",
    });
    let promotionError: string | undefined;
    try {
      let workspaceRevisionId: string | undefined;
      let committedArtifactIds: string[] = [];
      const outputs = [
        ...workDirCapture.files.map((file) => ({ path: file.path, bytes: file.bytes, mode: file.mode })),
        ...outputEnvelope.attachments.map((attachment) => ({
          path: attachment.fileName,
          bytes: readWorkspaceAttachmentBytesSync(attachment),
          mediaType: attachment.mediaType,
        })),
      ];
      if (outputs.length > 0 || workDirCapture.deletedPaths.length > 0) {
        const promoted = promoteTaskOutputsToWorkspaceSync({
          workspaceId: task.workspaceId,
          taskId: task.id,
          employeeName: agentName,
          outputs,
          deletedPaths: workDirCapture.deletedPaths,
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
      console.error(`[daemon] task ${task.id} outputs NOT committed; keeping preparing_commit: ${promotionError}`);
    }

    if (promotionError) return;
    const completion = withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        allowPreparingCommit: true,
        allowCommitted: true,
      });
      if (fence.ignored) return false;
      if (completionTokenUsage) {
        recordTokenUsageSync({
          workspaceId: task.workspaceId,
          taskQueueId: task.id,
          agentId: agentName,
          modelId: completionTokenUsage.modelId,
          providerAccountId: completionTokenUsage.providerAccountId,
          runtimeCredentialId: completionTokenUsage.runtimeCredentialId,
          routerSessionId: completionTokenUsage.routerSessionId,
          gatewayRequestId: completionTokenUsage.gatewayRequestId,
          inputTokens: completionTokenUsage.inputTokens,
          outputTokens: completionTokenUsage.outputTokens,
          channelName: completionTokenUsage.channelName,
        });
      }
      completeCommittedTaskSync({
        taskId: task.id,
        resultJson: {
          provider: runtime.provider,
          output: outputEnvelope.text,
          attachments: outputEnvelope.attachments,
          skillImports: skillImportOperations.imports,
          documentUpdates: documentOperations.documentUpdates,
          feishuLarkCliDataOperationRunIds: feishuLarkCliResultOperations.operationRunIds,
          feishuRuntimeDataOperationRunIds: feishuRuntimeDataOperationRequests.operationRunIds,
          feishuRuntimeDataOperationApprovalIds: feishuRuntimeDataOperationRequests.approvalIds,
          documentPermissionRequests: documentRuntimeOutputOperations.permissionRequests,
          knowledgeProposals: knowledgeProposalOperations.knowledgeProposals,
          ...(completionTokenUsage ? { tokenUsage: completionTokenUsage } : {}),
        },
        sessionId: result.sessionId,
        workDir,
      });
      completeWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        outputText: outputEnvelope.text,
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
      return true;
    });
    if (!completion) return;
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
    if (channelThreadId && payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        pendingSpeaker: agentName,
        speaker: agentName,
        conversationId: payload.conversationId,
        summary: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: conversationSessionId ?? undefined,
        workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of enqueueTaskCompletionFeishuOutbox({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        agentId: agentName,
        text: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [agentName],
          message: outputEnvelope.text,
          taskId: task.id,
        },
      })) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      if (payload.contactId) {
        writeConversationExecutionWorkspaceStateSync({
          channelName: payload.channel,
          agentId: payload.contactId,
          contactId: payload.contactId,
          sessionId: conversationSessionId,
          workDir,
          lastTaskQueueId: task.id,
          lastError: null,
        }, task.workspaceId);
        upsertDirectConversationStateSync(
          {
            contactId: payload.contactId,
            sessionId: conversationSessionId,
            workDir,
          },
          task.workspaceId,
        );
      }
    } else if (payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        speaker: runtime.name,
        summary: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: conversationSessionId ?? undefined,
        workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of enqueueTaskCompletionFeishuOutbox({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        agentId: agentName,
        text: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [agentName],
          message: outputEnvelope.text,
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
        agentId: agentName,
        sessionId: conversationSessionId,
        workDir,
        lastTaskQueueId: task.id,
        lastError: null,
      }, task.workspaceId);
    }
    upsertTaskCommitJournalSync({
      taskId: task.id,
      workspaceId: task.workspaceId,
      employeeName: agentName,
      commitState: "committed",
    });
    rmSync(recoveryStagingDir, { recursive: true, force: true });
  } catch (error) {
    if (taskCompletionCommitted) {
      console.error(`[daemon] task ${task.id} completed, but a post-completion action failed: ${error instanceof Error ? error.message : String(error)}`);
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "commit_reconciliation_retrying",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (taskCommitBoundaryCrossed && completionEffectsCheckpointed) {
      const currentTask = readQueuedTaskSync(task.id);
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: currentTask?.status === "committed" || currentTask?.status === "completed"
          ? "commit_reconciliation_retrying"
          : "workflow_completion_effects_checkpointed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError;
    const workflowErrorCode = resolveWorkflowCompletionFailureCode({
      commitBoundaryCrossed: taskCommitBoundaryCrossed,
      effectsCheckpointed: completionEffectsCheckpointed,
      errorCode: providerError?.code,
    });
    const failureApplied = withTransaction(getDatabase(), () => {
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        allowPreparingCommit: true,
      });
      if (fence.ignored) return false;
      failQueuedTaskSync({
        taskId: task.id,
        errorText: message,
        errorCode: workflowErrorCode,
        errorCategory: providerError?.category,
        provider: providerError?.provider,
        rawProviderMessage: providerError?.rawProviderMessage,
        sessionId: failureMetadata?.sessionId ?? payload.channelSessionId,
        workDir: failureMetadata?.workDir ?? workDir,
      });
      failWorkflowTaskIfLinkedSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        errorCode: workflowErrorCode,
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
      return true;
    });
    if (!failureApplied) return;
    if (persistedOutputAttachments.length > 0) {
      deleteWorkspaceAttachmentsSync(persistedOutputAttachments);
      persistedOutputAttachments = [];
    }
    appendTaskMessageSync({ taskId: task.id, type: "error", content: message });

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
    if (channelThreadId && payload.channel) {
      replacePendingChannelMessageSync({
        channel: payload.channel,
        pendingSpeaker: agentName,
        pendingTaskId: task.id,
        speaker: "系统提示",
        role: "agent",
        summary: formatConversationFailureSummary({
          agentName,
          channelName: payload.channel,
          errorText: message,
          isDirectConversation: Boolean(payload.contactId),
        }),
        status: "error",
      }, task.workspaceId);
      if (payload.contactId) {
        writeConversationExecutionWorkspaceStateSync({
          channelName: payload.channel,
          agentId: payload.contactId,
          contactId: payload.contactId,
          sessionId: payload.channelSessionId,
          workDir,
          lastTaskQueueId: task.id,
          lastError: message,
        }, task.workspaceId);
        upsertDirectConversationStateSync(
          {
            contactId: payload.contactId,
            sessionId: payload.channelSessionId,
            workDir,
          },
          task.workspaceId,
        );
      }
    } else if (payload.channel) {
      postMessageSync({
        channel: payload.channel,
        speaker: "系统提示",
        role: "agent",
        summary: formatTaskFailureSummary({
          title: payload.title || task.id,
          errorText: message,
        }),
        status: "error",
      }, task.workspaceId);
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: agentName,
        sessionId: payload.channelSessionId,
        workDir,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
    }
  } finally {
    await skillRunner?.close().catch((cleanupError) => {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `清理 Skill Runner 时出现警告：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      });
    });
    try {
      clearTaskOutputArtifacts(workDir);
    } catch (cleanupError) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `清理任务产物时出现警告：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      });
    }
    if (!channelThreadId) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
