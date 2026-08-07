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
  readHeadRevisionSync,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import type {
  DaemonTaskInputBundle,
  DaemonInputBundleFile,
  DaemonSkillDependencyEnvironment,
  DaemonWorkspaceInputManifest,
  RuntimeMcpConnectionContextEntry,
  TaskSkillExecutionSnapshot,
} from "@dofe-agent/domain";
import {
  buildSkillRunnerEntrypointsForSnapshotSync,
  buildContactAgentContext,
  isWorkflowTaskInputAvailableSync,
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
  if (!isWorkflowTaskInputAvailableSync({ workspaceId: task.workspaceId, taskQueueId: task.id })) {
    return Response.json({ error: "workflow_run_not_startable" }, { status: 409 });
  }

  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime || runtime.workspaceId !== auth.workspaceId) {
    return Response.json({ error: `Runtime "${task.runtimeId}" does not exist.` }, { status: 404 });
  }

  const workspaceState = readWorkspaceStateSync(auth.workspaceId);
  const agentProfile = workspaceState.activeEmployees.find(
    (employee) => employee.id === task.agentId || sameValue(employee.name, task.agentId),
  );
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
      skipWorkspaceMaterialization: true,
    });
    if (prepared.skillReadinessBlockers.length > 0 || prepared.skillEnvConflicts.length > 0) {
      const blockingReasons = [
        ...prepared.skillReadinessBlockers,
        ...prepared.skillEnvConflicts.map((key) => `environment variable conflict: ${key}`),
      ];
      const visibleReasons = blockingReasons.slice(0, 3).join("; ");
      const remainingCount = blockingReasons.length - Math.min(blockingReasons.length, 3);
      return Response.json(
        {
          error:
            `Task cannot start because skill requirements are not satisfied: ${visibleReasons}`
            + (remainingCount > 0 ? `; and ${remainingCount} more blocker(s).` : "."),
          code: "skill_requirements_unsatisfied",
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
        // values over the authenticated daemon control-plane (mTLS + daemon
        // token). The daemon partitions these values against the frozen Runner
        // entrypoint configKeys: declared keys only enter the Runner's random
        // short-lived config file, while compatibility-only keys may enter the
        // Provider environment and remain value-redacted from its output.
        // Values are never materialized through bundle.files.
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
                agentId: task.employeeId,
                triggerType: task.triggerType,
                payload: prepared.payload,
              },
              null,
              2,
            ), "utf8"),
        ),
        ...collectBundleFiles(tempDir),
      ],
      workspace: readWorkspaceInputManifest(task.employeeId, auth.workspaceId),
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

function readWorkspaceInputManifest(employeeId: string, workspaceId: string): DaemonWorkspaceInputManifest | undefined {
  const head = readHeadRevisionSync(employeeId, workspaceId);
  if (!head) {
    return undefined;
  }
  let parsed: { files?: unknown };
  try {
    parsed = JSON.parse(head.manifestJson) as { files?: unknown };
  } catch {
    throw new InputBundleValidationError("workspace.manifest_invalid", "Workspace head manifest is not valid JSON.");
  }
  if (!Array.isArray(parsed.files)) {
    throw new InputBundleValidationError("workspace.manifest_invalid", "Workspace head manifest has no files array.");
  }
  const paths = new Set<string>();
  const files = parsed.files.map((value, index) => {
    const file = value as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const sha256 = typeof file.sha256 === "string" ? file.sha256.toLowerCase() : "";
    const size = file.size;
    const mediaType = typeof file.mediaType === "string" ? file.mediaType : "";
    if (
      !path || path.startsWith("/") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || paths.has(path) || !/^[a-f0-9]{64}$/.test(sha256)
      || !Number.isSafeInteger(size) || (size as number) < 0 || !mediaType
    ) {
      throw new InputBundleValidationError(
        "workspace.manifest_invalid",
        `Workspace head manifest contains an invalid file at index ${index}.`,
      );
    }
    paths.add(path);
    return {
      path,
      sha256,
      size: size as number,
      mediaType,
      ...(typeof file.mode === "string" ? { mode: file.mode } : {}),
    };
  });
  return { revisionId: head.id, manifestDigest: head.manifestDigest, files };
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
