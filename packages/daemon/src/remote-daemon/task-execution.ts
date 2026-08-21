// 3.5-4：自 remote-daemon.ts 拆出——单任务执行主流程（bundle 物化、skill
// runner、MCP 会话、provider 调用、用量上报、产物回传）及其辅助函数。
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDaemonChannelWorkDirPath, getDaemonTaskWorkDirPath } from "@dofe-agent/db";
import { resolveProviderProtocols } from "@dofe-agent/domain";
import type { ClaimedDaemonTask, DaemonTaskInputBundle } from "../daemon-api.ts";
import {
  clearTaskOutputArtifacts,
  materializeRemoteInputBundle,
  prepareRemoteOutputBundle,
  readWorkspaceBlobUploadBytes,
} from "../bundle.ts";
import { uploadBlobsWithConcurrency } from "../resumable-transfer.ts";
import type { HttpDaemonClient } from "../daemon-client.ts";
import { prepareSkillImportOperationArtifacts } from "../skill-imports.ts";
import { buildSkillDependencyTaskEnvironment } from "../skill-install/task-environment.ts";
import { partitionSkillEnvironment } from "../skill-environment.ts";
import { startSkillRunnerBroker, type SkillRunnerBroker } from "../skill-runner.ts";
import {
  normalizeProviderTaskErrorCategory,
  readProviderTaskFailureMetadata,
  runProviderTask,
  type ProviderApprovalDecision,
  type ProviderApprovalRequest,
  type ProviderTaskEvent,
  type RemoteRuntimeRecord,
} from "../provider-runtime.ts";
import { parseTaskInputJson, resolveConversationThreadId } from "../task-context.ts";
import { McpAuditOutbox } from "../mcp/audit-outbox.ts";
import { getManagedRuntimeHomeDir, type ManagedCredentialResolver } from "../managed-provider-credentials.ts";
import type { RemoteDaemonConfig } from "./config.ts";
import { attachTaskManagedMcpConnection, getMcpGatewayForTask } from "./mcp.ts";
import { buildClaudeMcpToolPermissionName } from "../mcp/gateway.ts";
import {
  createRemoteGatewayUsageReporter,
  mergeRemoteGatewayUsages,
  readFiniteNumber,
  readRemoteGatewayUsages,
  type RemoteGatewayUsageReporter,
  type RemoteTaskUsageEntry,
} from "./usage.ts";
import { resolveManagedCredentialProfile } from "./operations.ts";
import { sleep } from "./internal.ts";

const RUNTIME_APPROVAL_TIMEOUT_MS = 15 * 60 * 1_000;

export function resolveRemoteTaskExecutionModel(bundle: DaemonTaskInputBundle): string | undefined {
  return bundle.metadata.effectiveModel?.modelId.trim() || undefined;
}

export async function executeRemoteTask(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
  task: ClaimedDaemonTask,
  credentialResolver?: ManagedCredentialResolver,
  mcpAuditOutbox?: McpAuditOutbox,
): Promise<void> {
  const workDir = resolveRemoteTaskWorkDir(config, task);
  const isPersistentConversationWorkspace = isConversationScopedRemoteTask(task);
  if (!isPersistentConversationWorkspace) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });

  // Task-scoped MCP session: the daemon claims resolved connection bundles
  // through its authenticated channel and hosts a task-scoped gateway. The
  // Provider's own MCP config only ever receives the gateway URL.
  let mcpSession: { url: string; revoke: () => void } | undefined;
  let mcpToolPermissionNames: string[] = [];
  let skillRunner: SkillRunnerBroker | undefined;
  let gatewayUsageReporter: RemoteGatewayUsageReporter | undefined;
  const cancellationController = new AbortController();
  const stopCancellationWatch = watchRemoteTaskCancellation(client, task.id, cancellationController);

  try {
    await client.startTask(task.id);
    const bundle = await client.getInputBundle(task.id);
    await materializeRemoteInputBundle({
      workDir,
      stateDir: config.stateDir,
      bundle,
      fetchWorkspaceBlob: (taskId, revisionId, sha256) => client.getWorkspaceBlob(taskId, revisionId, sha256),
      fetchWorkspaceBlobRange: (taskId, revisionId, sha256, start, end) =>
        client.getWorkspaceBlobRange(taskId, revisionId, sha256, start, end),
    });
    const runnerEntrypoints = bundle.metadata.skillRunnerEntrypoints ?? [];
    const skillEnvironment = partitionSkillEnvironment(bundle.metadata.skillEnv, runnerEntrypoints);
    skillRunner = await startSkillRunnerBroker({
      stateDir: config.stateDir,
      workspaceId: task.workspaceId,
      workDir,
      entrypoints: runnerEntrypoints,
      dependencyEnvironments: bundle.metadata.skillDependencyEnvironments,
      skillEnv: skillEnvironment.runnerEnv,
      // Persistent Skill Runner invocation audit (P1-3): report each entrypoint
      // run to the control plane; the server dedups by eventId.
      reportInvocation: (report) => client.reportSkillRunnerInvocations(task.id, [{
        eventId: report.eventId,
        workspaceId: task.workspaceId,
        runtimeId: runtime.id,
        agentId: task.agentId,
        entrypoint: {
          key: report.entrypoint.key,
          skillId: report.entrypoint.skillId,
          skillName: report.entrypoint.skillName,
          installationId: report.entrypoint.installationId,
          artifactDigest: report.entrypoint.artifactDigest,
          id: report.entrypoint.id,
          path: report.entrypoint.path,
          runtime: report.entrypoint.runtime,
        },
        exitCode: report.exitCode,
        timedOut: report.timedOut,
        durationMs: report.durationMs,
        safeSummary: report.safeSummary,
      }]),
    });

    if (bundle.metadata.mcpConnections?.status === "available") {
      // One attempt id per task execution makes the claim idempotent under
      // HTTP retry: a lost response retries with the same id and the server
      // replays the persisted grant instead of returning "no MCP".
      const claimAttemptId = randomUUID();
      const claimed = await client.claimMcpTaskSession(task.id, claimAttemptId);
      if (claimed.connections.length === 0) {
        // Fail closed: the task expects MCP connections but the claim returned
        // none (connections were dropped/reconfigured mid-flight). Running the
        // task without MCP would silently lose the authorized capability.
        throw new Error("mcp.session_claim_failed: task expects MCP connections but claim returned none");
      }
      const gateway = await getMcpGatewayForTask(
        client,
        mcpAuditOutbox ?? new McpAuditOutbox(config.stateDir),
        config.managedNode,
      );
      mcpSession = gateway.createTaskSession({
        taskId: task.id,
        runtimeId: runtime.id,
        workspaceId: task.workspaceId,
        employeeId: task.employeeId?.trim() || task.agentId,
        conversationId: task.routerSessionId?.trim()
          || resolveConversationThreadId({ triggerType: task.triggerType, payload: parseTaskInputJson(task.inputJson) })
          || task.id,
        connections: claimed.connections.map((connection) => attachTaskManagedMcpConnection(connection, config, runtime)),
      });
      mcpToolPermissionNames = claimed.connections.flatMap((connection) =>
        connection.tools.map((tool) => buildClaudeMcpToolPermissionName(tool.id))
      );
    }

    const managedProfile = await resolveManagedCredentialProfile(runtime, credentialResolver);
    const managedCredentialEnv = managedProfile?.environment ?? {};
    if (bundle.metadata.skillEnvConflicts && bundle.metadata.skillEnvConflicts.length > 0) {
      throw new Error(
        `Skill environment variable conflicts detected: ${bundle.metadata.skillEnvConflicts.join(", ")}. ` +
          "Resolve by using the same value across skills or uninstalling conflicting skills.",
      );
    }
    if (bundle.metadata.skillReadinessBlockers?.length) {
      throw new Error(
        `Skill requirements not satisfied for this task: ${bundle.metadata.skillReadinessBlockers.join("; ")}.`,
      );
    }
    const skillDependencyEnv = buildSkillDependencyTaskEnvironment({
      stateDir: config.stateDir,
      workspaceId: task.workspaceId,
      environments: bundle.metadata.skillDependencyEnvironments ?? [],
      baseEnv: {
        ...process.env,
        ...skillEnvironment.providerEnv,
        ...managedCredentialEnv,
      },
    });
    const managedCredentialId = typeof runtime.metadata.managedCredentialId === "string"
      ? runtime.metadata.managedCredentialId
      : undefined;
    const taskRuntime = managedProfile && credentialResolver
      ? {
          ...runtime,
          metadata: {
            ...runtime.metadata,
            executablePath: credentialResolver.getExecutablePath(runtime.id, runtime.provider),
          },
        }
      : runtime;
    const effectiveModelId = resolveRemoteTaskExecutionModel(bundle);
    let usages: RemoteTaskUsageEntry[] = [];
    let queuedMessageReports = Promise.resolve();
    const reportTaskMessage = (message: ProviderTaskEvent): void => {
      queuedMessageReports = queuedMessageReports
        .then(() => client.reportMessages(task.id, { messages: [message] }))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`Failed to report remote task message for ${task.id}: ${detail}`);
        });
    };
    reportTaskMessage({ type: "status", content: "正在准备执行环境" });
    const gatewayRequestLogPath = join(workDir, ".dofe-gateway-requests.jsonl");
    rmSync(gatewayRequestLogPath, { force: true });
    if (effectiveModelId && managedCredentialId) {
      gatewayUsageReporter = createRemoteGatewayUsageReporter({
        path: gatewayRequestLogPath,
        context: {
          modelId: effectiveModelId,
          runtimeCredentialId: managedCredentialId,
          routerSessionId: task.routerSessionId,
        },
        report: (reportedUsages) => client.reportTaskUsages(task.id, { usages: reportedUsages }),
        onError: (error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`Failed to report incremental usage for task ${task.id}: ${detail}`);
        },
      });
    }

    const result = await runProviderTask(
      taskRuntime,
      bundle.prompt,
      workDir,
      {
        sessionId: resolveRemoteTaskExecutionSessionId(bundle.metadata.routerSession, task.inputJson),
        modelId: effectiveModelId,
        executionPolicy: bundle.metadata.executionPolicy,
        skillEnvKeys: Object.keys(skillEnvironment.providerEnv),
        taskTimeoutMs: config.taskTimeoutMs,
        contextEnv: {
          ...skillEnvironment.providerEnv,
          ...managedCredentialEnv,
          ...skillDependencyEnv,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_AGENT_NAME: readRemoteTaskAgentName(task),
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
          ...(managedCredentialId ? {
            DOFE_AGENT_RUNTIME_CREDENTIAL_ID: managedCredentialId,
            DOFE_AGENT_RUNTIME_ID: runtime.id,
            DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID: task.agentId,
            DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID: task.routerSessionId ?? task.id,
            DOFE_AGENT_ATTRIBUTION_ROOT_TASK_ID: task.id,
            DOFE_AGENT_GATEWAY_REQUEST_LOG: "/workspace/.dofe-gateway-requests.jsonl",
            DOFE_AGENT_GATEWAY_PROTOCOL: resolveProviderProtocols(runtime.provider)[0] ?? "",
          } : {}),
        },
        runtimeApps: bundle.metadata.runtimeApps?.apps ?? [],
        runtimeAppBinDir: join(getManagedRuntimeHomeDir(config.stateDir, runtime.id), ".local", "bin"),
        // Docker-out-of-Docker bind sources are visible to the provider child but
        // not to this daemon container, so host command diagnostics are invalid.
        runtimeAppHostDiagnostics: !config.managedNode,
        runtimeToolCapabilities: [
          ...(bundle.metadata.runtimeToolCapabilities?.capabilities ?? []),
          ...skillRunner.capabilities,
        ],
        mcpGatewayUrl: mcpSession?.url,
        // MCP config injection only registers the server. Claude Code also
        // requires explicit permission rules for each task-authorized tool.
        temporaryAllowedTools: mcpToolPermissionNames.length > 0 ? mcpToolPermissionNames : undefined,
        codexMcpInjectionEnabled: config.codexMcpExperimentalEnabled,
        onEvent: (event) => {
          if (event.type === "usage" && event.inputJson) {
            const inputTokens = readFiniteNumber(event.inputJson.input_tokens);
            const outputTokens = readFiniteNumber(event.inputJson.output_tokens);
            if (effectiveModelId && managedCredentialId && (inputTokens > 0 || outputTokens > 0)) {
              usages.push({
                modelId: effectiveModelId,
                runtimeCredentialId: managedCredentialId,
                routerSessionId: task.routerSessionId,
                gatewayRequestId: typeof event.inputJson.gateway_request_id === "string"
                  ? event.inputJson.gateway_request_id.trim() || undefined
                  : undefined,
                inputTokens,
                outputTokens,
              });
            }
          }
          reportTaskMessage(event);
        },
        onApprovalRequest: (request) => waitForRuntimeApproval(client, task.id, request),
        signal: cancellationController.signal,
      },
    );

    if (effectiveModelId && managedCredentialId) {
      await gatewayUsageReporter?.flush();
      usages = mergeRemoteGatewayUsages(usages, readRemoteGatewayUsages(gatewayRequestLogPath), {
        modelId: effectiveModelId,
        runtimeCredentialId: managedCredentialId,
        routerSessionId: task.routerSessionId,
      });
    }
    rmSync(gatewayRequestLogPath, { force: true });

    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    for (const warning of preparedSkillImports.warnings) {
      reportTaskMessage({ type: "status", content: warning });
    }

    // Remote daemons must not read the control-plane database. The claim-time
    // workspace manifest is already authenticated and included in the bundle.
    const preparedOutput = prepareRemoteOutputBundle(workDir, bundle.workspace);
    if (preparedOutput.uploads.length > 0) {
      await uploadBlobsWithConcurrency({
        taskId: task.id,
        entries: preparedOutput.uploads.map((upload) => ({
          sha256: upload.sha256,
          size: upload.size,
          readBytes: async () => readWorkspaceBlobUploadBytes(upload),
        })),
        uploadBlob: (taskId, sha256, bytes) => client.uploadWorkspaceBlob(taskId, sha256, bytes),
      });
    }
    if (preparedOutput.bundle) {
      await client.uploadOutputBundle(task.id, preparedOutput.bundle);
    }

    await queuedMessageReports;
    await client.completeTask(task.id, {
      outputText: result.output,
      sessionId: result.sessionId,
      workDir,
      usages: usages.length > 0 ? usages : undefined,
    });
  } catch (error) {
    if (cancellationController.signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError;
    await client.failTask(task.id, {
      errorText: message,
      runtimeCredentialId: runtime.metadata.managedCredentialId,
      errorCode: providerError?.code,
      errorCategory: normalizeProviderTaskErrorCategory(providerError?.category),
      provider: providerError?.provider,
      rawProviderMessage: providerError?.rawProviderMessage,
      sessionId: failureMetadata?.sessionId,
      workDir: failureMetadata?.workDir ?? workDir,
    });
  } finally {
    stopCancellationWatch();
    try {
      await gatewayUsageReporter?.stop();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Failed final incremental usage report for task ${task.id}: ${detail}`);
    }
    // Revoke the MCP session. Tool audits are now flushed per-call by the
    // gateway's onAudit handler, so a daemon crash loses at most the in-flight
    // call rather than the entire task's audit trail.
    mcpSession?.revoke();
    await skillRunner?.close();
    clearTaskOutputArtifacts(workDir);
    if (!isPersistentConversationWorkspace) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

export function watchRemoteTaskCancellation(
  client: Pick<HttpDaemonClient, "getTaskStatus">,
  taskId: string,
  controller: AbortController,
  options?: { pollIntervalMs?: number; onError?: (error: unknown) => void },
): () => void {
  const pollIntervalMs = Math.max(10, options?.pollIntervalMs ?? 2_000);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    try {
      const response = await client.getTaskStatus(taskId);
      if (response.task.status === "cancelled") {
        controller.abort(new Error("task_cancelled"));
        return;
      }
    } catch (error) {
      options?.onError?.(error);
    }
    if (!stopped && !controller.signal.aborted) {
      timer = setTimeout(() => void poll(), pollIntervalMs);
    }
  };

  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function waitForRuntimeApproval(
  client: HttpDaemonClient,
  taskId: string,
  request: ProviderApprovalRequest,
): Promise<ProviderApprovalDecision> {
  const created = await client.createRuntimeApproval(taskId, {
    provider: request.provider,
    runtimeId: request.runtimeId,
    sessionId: request.sessionId,
    toolName: request.toolName,
    toolInput: request.toolInput,
    contentPreview: request.contentPreview,
  });
  await client.reportMessages(taskId, {
    messages: [{
      type: "status",
      content: "等待你的工具审批，任务已暂停。",
    }],
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to report approval wait message for ${taskId}: ${message}`);
  });

  const deadline = Date.now() + RUNTIME_APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await client.getRuntimeApproval(taskId, created.approval.approvalId);
    if (current.approval.status === "approved") {
      return {
        decision: "approved",
        comment: current.approval.reviewerComment,
      };
    }
    if (current.approval.status === "rejected") {
      return {
        decision: "rejected",
        comment: current.approval.reviewerComment,
      };
    }
    await sleep(1_000);
  }

  throw new Error("Runtime approval timed out after 15 minutes.");
}

export function resolveRemoteTaskWorkDir(config: Pick<RemoteDaemonConfig, "stateDir">, task: ClaimedDaemonTask): string {
  const payload = parseTaskInputJson(task.inputJson);
  const channelThreadId = resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  });
  const executionThreadId = task.routerSessionId?.trim() || channelThreadId;
  if (executionThreadId) {
    return getDaemonChannelWorkDirPath(config.stateDir, {
      workspaceId: task.workspaceId,
      threadId: executionThreadId,
      agentId: task.agentId,
    });
  }

  return getDaemonTaskWorkDirPath(config.stateDir, {
    workspaceId: task.workspaceId,
    taskId: task.id,
  });
}

function isConversationScopedRemoteTask(task: ClaimedDaemonTask): boolean {
  const payload = parseTaskInputJson(task.inputJson);
  return Boolean(resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  }));
}

export function resolveRemoteTaskProviderSessionId(inputJson: string): string | undefined {
  const sessionId = parseTaskInputJson(inputJson).channelSessionId?.trim();
  return sessionId || undefined;
}

export function resolveRemoteTaskExecutionSessionId(
  routerSession: DaemonTaskInputBundle["metadata"]["routerSession"],
  inputJson: string,
): string | undefined {
  if (routerSession) {
    return routerSession.providerSessionId?.trim() || undefined;
  }
  return resolveRemoteTaskProviderSessionId(inputJson);
}

function readRemoteTaskAgentName(task: ClaimedDaemonTask): string {
  return parseTaskInputJson(task.inputJson).assignee?.trim() || task.agentId;
}
