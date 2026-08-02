import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  assertDaemonInputBundleBudget,
  buildDocumentRuntimeToolCapabilities,
  createDaemonBundleFile,
  InputBundleValidationError,
  parseTaskPayload,
  prepareDaemonTaskContext,
  type RouterSessionPromptContext,
} from "dofe-agent-daemon";
import {
  chooseProviderSessionForTaskSync,
  listAgentRouterEventsSync,
  listAgentTaskAttemptsSync,
  readAgentRouterSessionForTaskSync,
  readLatestAgentRouterContextSnapshotSync,
  readAgentRuntimeSync,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import type {
  DaemonTaskInputBundle,
  DaemonInputBundleFile,
  DaemonSkillDependencyEnvironment,
  RuntimeMcpConnectionContextEntry,
  TaskSkillExecutionSnapshot,
} from "@dofe-agent/domain";
import {
  buildSkillRunnerEntrypointsForSnapshotSync,
  buildContactAgentContext,
  readWorkspaceStateSync,
  resolveAgentDocumentContextSync,
  resolveAgentRuntimeMode,
  resolveCompatibleDirectChannelRecord,
  resolveEffectiveModelForTaskAsync,
  redactToolInputSchema,
  sameValue,
  type EffectiveModelResolution,
} from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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

  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime || runtime.workspaceId !== auth.workspaceId) {
    return Response.json({ error: `Runtime "${task.runtimeId}" does not exist.` }, { status: 404 });
  }

  const workspaceState = readWorkspaceStateSync(auth.workspaceId);
  const agentProfile = workspaceState.activeEmployees.find((employee) => sameValue(employee.name, task.agentId));
  const payload = parseTaskPayload(task);
  const compatibleDirectChannelName =
    payload.contactId && !payload.channelName
      ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name
      : undefined;
  const effectivePayload =
    compatibleDirectChannelName && payload.contactId && !payload.channelName
      ? {
          ...payload,
          channelName: compatibleDirectChannelName,
          channelMessage: payload.channelMessage,
        }
      : payload;
  const contactContext =
    payload.contactId ? buildContactAgentContext(workspaceState, payload.contactId) : undefined;
  const agentName = effectivePayload.assignee ?? task.agentId;
  const agentDocumentContexts = resolveAgentDocumentContextSync({
    workspaceId: auth.workspaceId,
    agentName,
    channelName: effectivePayload.channelName,
  });
  const channelDocuments = agentDocumentContexts.map((context) => context.document);
  const routerSessionContext = buildRouterSessionPromptContext(task);
  const tempDir = mkdtempSync(join(tmpdir(), `dofe-agent-task-input-${task.id}-`));

  try {
    const prepared = prepareDaemonTaskContext({
      runtime,
      task,
      workDir: tempDir,
      agentProfile,
      channelDocuments,
      agentDocumentContexts,
      contactContext,
      payloadOverride: effectivePayload,
      routerSessionContext,
    });
    if (prepared.skillReadinessBlockers.length > 0 || prepared.skillEnvConflicts.length > 0) {
      return Response.json(
        {
          error: "Task cannot start because skill requirements are not satisfied.",
          skillReadinessBlockers: prepared.skillReadinessBlockers,
          skillEnvConflicts: prepared.skillEnvConflicts,
        },
        { status: 409 },
      );
    }
    const runtimeToolCapabilities = [
      ...buildRuntimeToolCapabilitiesForBundle(prepared.runtimeApps),
      ...buildDocumentRuntimeToolCapabilities(prepared.agentDocumentContexts),
    ];
    let effectiveModel: EffectiveModelResolution | undefined;
    if (runtime.managedCredentialId && resolveAgentRuntimeMode() === "remote") {
      try {
        effectiveModel = await resolveEffectiveModelForTaskAsync({
          workspaceId: auth.workspaceId,
          employeeName: agentName,
          runtimeId: runtime.id,
          routerSessionId: task.routerSessionId,
        });
      } catch (error) {
        // Model resolution failed — return a structured error so the daemon
        // can surface a user-facing message instead of a bare 500.
        const message = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: `无法为 AI员工 "${agentName}" 解析模型：${message}`, code: "model_resolution_failed", detail: message },
          { status: 424 },
        );
      }
    }
    const bundle: DaemonTaskInputBundle = {
      version: 1,
      format: "json-inline-v1",
      taskId: task.id,
      runtimeId: runtime.id,
      prompt: prepared.prompt,
      metadata: {
        taskTitle: prepared.payload.title,
        taskTriggerType: task.triggerType,
        channelName: prepared.payload.channelName,
        contactId: prepared.payload.contactId,
        // Threat model (spec §6.2): skillEnv carries plaintext secret/sensitive
        // values so the authenticated daemon can inject REAL values into the
        // provider subprocess. This bundle travels only over the authenticated
        // daemon control-plane (mTLS + daemon token). Values are never logged,
        // never persisted to disk by the daemon (only bundle.files is
        // materialized), and are redacted by value from all provider
        // stdout/stderr (buildEnvValueRedactions, keyed off these names) before
        // any execution result is stored or surfaced.
        skillEnv: prepared.skillEnv,
        skillEnvConflicts: prepared.skillEnvConflicts,
        skillReadinessBlockers: prepared.skillReadinessBlockers,
        skillDependencyEnvironments: buildSkillDependencyEnvironmentsForTaskBundle(
          prepared.skillExecutionSnapshot,
        ),
        skillRunnerEntrypoints: buildSkillRunnerEntrypointsForSnapshotSync(prepared.skillExecutionSnapshot),
        effectiveModel,
        executionPolicy: agentProfile?.executionPolicy,
        runtimeApps: {
          status: prepared.runtimeApps.length > 0 ? "available" : "none",
          apps: prepared.runtimeApps,
        },
        // This is a non-secret manifest only. The remote endpoint, request
        // configuration, and decrypted credentials stay in the future daemon
        // MCP gateway, never in this Provider-visible task bundle.
        mcpConnections: buildMcpConnectionsForTaskBundle(prepared.mcpConnections),
        runtimeToolCapabilities: {
          status: runtimeToolCapabilities.length > 0 ? "available" : "none",
          capabilities: runtimeToolCapabilities,
        },
        routerSession: routerSessionContext
          ? {
              routerSessionId: routerSessionContext.routerSessionId,
              conversationKey: routerSessionContext.conversationKey,
              sourceType: routerSessionContext.sourceType,
              providerSessionId: routerSessionContext.providerSessionId,
              continuationMode: routerSessionContext.continuationMode ?? "cold_rebuild",
              selectedRuntimeId: routerSessionContext.selectedRuntimeId ?? runtime.id,
              previousRuntimeId: routerSessionContext.previousRuntimeId,
              fallbackReason: routerSessionContext.fallbackReason,
              attemptCount: routerSessionContext.attemptCount ?? 0,
            }
          : undefined,
      },
      files: [
        createDaemonBundleFile("prompt.txt", Buffer.from(prepared.prompt, "utf8")),
        createDaemonBundleFile(
          "task.json",
          Buffer.from(JSON.stringify(
              {
                taskId: task.id,
                runtimeId: runtime.id,
                agentId: task.agentId,
                triggerType: task.triggerType,
                payload: prepared.payload,
              },
              null,
              2,
            ), "utf8"),
        ),
        ...collectBundleFiles(tempDir),
      ],
    };

    assertDaemonInputBundleBudget(bundle.files);

    return Response.json(bundle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof Error
      && (error as Error & { code?: unknown }).code === "workspace.materialization_incomplete"
    ) {
      return Response.json(
        { error: "workspace.materialization_incomplete", detail: message },
        { status: 409 },
      );
    }
    if (error instanceof InputBundleValidationError) {
      return Response.json({ error: error.code, detail: error.message }, { status: 413 });
    }
    throw error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function buildSkillDependencyEnvironmentsForTaskBundle(
  snapshot?: TaskSkillExecutionSnapshot,
): DaemonSkillDependencyEnvironment[] {
  return (snapshot?.entries ?? [])
    .filter((entry) => entry.dependencyEnvironmentRequired)
    .map((entry) => {
      if (!entry.releaseLockDigest) {
        throw new Error(
          `skill_dependency_environment_snapshot_invalid: installation "${entry.installationId}" has no release lock digest.`,
        );
      }
      return {
        installationId: entry.installationId,
        artifactDigest: entry.artifactDigest,
        releaseLockDigest: entry.releaseLockDigest,
      };
    });
}

/**
 * Projects a task's MCP manifest across the Provider boundary. Do not spread
 * the source records here: future connection fields must remain daemon-only by
 * default, including endpoints, configuration, and credentials.
 */
export function buildMcpConnectionsForTaskBundle(
  connections: RuntimeMcpConnectionContextEntry[],
): NonNullable<DaemonTaskInputBundle["metadata"]["mcpConnections"]> {
  return {
    status: connections.length > 0 ? "available" : "none",
    connections: connections.map((connection) => ({
      connectionId: connection.connectionId,
      catalogItemId: connection.catalogItemId,
      catalogItemSlug: connection.catalogItemSlug,
      catalogItemVersion: connection.catalogItemVersion,
      displayName: connection.displayName,
      transport: connection.transport,
      approvedTools: [...connection.approvedTools],
      tools: connection.tools.map((tool) => ({
        id: tool.id,
        connectionId: tool.connectionId,
        name: tool.name,
        description: tool.description,
        inputSchema: redactToolInputSchema(tool.inputSchema),
      })),
    })),
  };
}

function buildRuntimeToolCapabilitiesForBundle(
  runtimeApps: NonNullable<DaemonTaskInputBundle["metadata"]["runtimeApps"]>["apps"],
): NonNullable<DaemonTaskInputBundle["metadata"]["runtimeToolCapabilities"]>["capabilities"] {
  return runtimeApps.flatMap((app) => {
    const command = app.entryPoint?.trim();
    if (!command) {
      return [];
    }
    return [{
      id: `clihub:${app.source}:${app.name}`,
      command,
      displayName: app.displayName || app.name,
      allowedShellPatterns: [`${command} *`, `${command} --help`, `command -v ${command}`],
      diagnosticCommands: [`command -v ${command}`],
      source: "cli-hub" as const,
    }];
  });
}

function buildRouterSessionPromptContext(task: QueuedTaskRecord): RouterSessionPromptContext | undefined {
  const routerSession = readAgentRouterSessionForTaskSync(task);
  if (!routerSession) {
    return undefined;
  }
  const providerSession = chooseProviderSessionForTaskSync({ task });
  const attempts = listAgentTaskAttemptsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    limit: 80,
  });
  const taskAttempts = attempts.filter((attempt) => attempt.taskQueueId === task.id);
  const previousAttempt = taskAttempts.length > 1 ? taskAttempts[taskAttempts.length - 2] : undefined;
  const latestAttempt = taskAttempts[taskAttempts.length - 1];
  const latestHandoff = readLatestAgentRouterContextSnapshotSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    snapshotType: "handoff",
  });
  const events = listAgentRouterEventsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    order: "asc",
    limit: 80,
  });
  const metadata = latestAttempt ? safeParseJson(latestAttempt.metadataJson) : {};
  const fallbackReason = readString(metadata.fallbackReason);
  return {
    routerSessionId: routerSession.id,
    conversationKey: routerSession.conversationKey,
    sourceType: routerSession.sourceType,
    memorySummary: routerSession.memorySummary,
    providerSessionId: providerSession?.providerSessionId,
    continuationMode: fallbackReason
      ? "fallback"
      : providerSession
        ? "same_provider_resume"
        : "cold_rebuild",
    previousRuntimeId: previousAttempt?.runtimeId,
    selectedRuntimeId: task.runtimeId,
    fallbackReason,
    transcriptLines: events.map((event) => {
      const actor = event.actorId ? `${event.actorType}:${event.actorId}` : event.actorType;
      return `${event.createdAt} | ${event.type} | ${actor} | ${event.summary ?? ""}`;
    }),
    latestHandoffSnapshot: latestHandoff?.contentMarkdown,
    attemptCount: attempts.length,
  };
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function collectBundleFiles(rootDir: string): DaemonInputBundleFile[] {
  const files: DaemonInputBundleFile[] = [];
  walk(rootDir, rootDir, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function walk(rootDir: string, currentDir: string, files: DaemonInputBundleFile[]): void {
  for (const entry of readdirSync(currentDir)) {
    const absolutePath = join(currentDir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      walk(rootDir, absolutePath, files);
      continue;
    }
    files.push(createDaemonBundleFile(
      relative(rootDir, absolutePath).replace(/\\/g, "/"),
      readFileSync(absolutePath),
      // Preserve the executable bit so scripts that passed install stay runnable
      // in the task workDir (a missing exec bit would otherwise fail at runtime).
      (stats.mode & 0o111) !== 0 ? (stats.mode & 0o777).toString(8) : undefined,
    ));
  }
}
