import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  buildDocumentRuntimeToolCapabilities,
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
import type { DaemonTaskInputBundle, DaemonBundleFile } from "@dofe-agent/domain";
import {
  buildContactAgentContext,
  readWorkspaceStateSync,
  resolveAgentDocumentContextSync,
  resolveCompatibleDirectChannelRecord,
  sameValue,
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
    const runtimeToolCapabilities = [
      ...buildRuntimeToolCapabilitiesForBundle(prepared.runtimeApps),
      ...buildDocumentRuntimeToolCapabilities(prepared.agentDocumentContexts),
    ];
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
        runtimeApps: {
          status: prepared.runtimeApps.length > 0 ? "available" : "none",
          apps: prepared.runtimeApps,
        },
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
        {
          path: "prompt.txt",
          contentBase64: Buffer.from(prepared.prompt, "utf8").toString("base64"),
        },
        {
          path: "task.json",
          contentBase64: Buffer.from(
            JSON.stringify(
              {
                taskId: task.id,
                runtimeId: runtime.id,
                agentId: task.agentId,
                triggerType: task.triggerType,
                payload: prepared.payload,
              },
              null,
              2,
            ),
            "utf8",
          ).toString("base64"),
        },
        ...collectBundleFiles(tempDir),
      ],
    };

    return Response.json(bundle);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

function collectBundleFiles(rootDir: string): DaemonBundleFile[] {
  const files: DaemonBundleFile[] = [];
  walk(rootDir, rootDir, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function walk(rootDir: string, currentDir: string, files: DaemonBundleFile[]): void {
  for (const entry of readdirSync(currentDir)) {
    const absolutePath = join(currentDir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      walk(rootDir, absolutePath, files);
      continue;
    }
    files.push({
      path: relative(rootDir, absolutePath).replace(/\\/g, "/"),
      contentBase64: readFileSync(absolutePath).toString("base64"),
    });
  }
}
