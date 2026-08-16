// 3.5-4：自 task-context.ts 拆出——prepareDaemonTaskContext 主编排：物化
// durable head → 解析 skills/知识/通知 → 组装 prompt 与执行上下文。
import type { AgentRuntimeRecord, QueuedTaskRecord } from "@dofe-agent/db";
import type {
  RuntimeAppContextEntry,
  RuntimeMcpConnectionContextEntry,
  TaskSkillExecutionSnapshot,
} from "@dofe-agent/domain";
import type { ActiveEmployee, ChannelDocument, KnowledgePage, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import {
  listDocumentPermissionRequestsSync,
  listReadyMcpConnectionsForTaskSync,
  listRuntimeAppContextEntriesForRuntimeSync,
  readWorkspaceStateSync,
  resolveOrLoadTaskSkillExecutionSnapshotSync,
  resolveSkillProjectWorkDirSync,
  type AgentDocumentContext,
  type ContactAgentContext,
  type FeishuLarkCliResourceGrant,
  type WorkspaceNotificationRecord,
} from "@dofe-agent/services";
import { materializeChannelDocuments } from "../channel-documents.ts";
import { materializeHeadRevisionToWorkDir } from "../workdir-capture.ts";
import { parseTaskPayload, type ParsedTaskPayload } from "./payload.ts";
import { resolveAgentNotificationsForTask } from "./notifications.ts";
import {
  materializeAgentKnowledgePages,
  materializeAgentSkills,
  materializeAttachments,
  resolveAgentKnowledgePages,
} from "./materialize.ts";
import {
  buildRuntimeCapabilityIds,
  collectSkillReadinessBlockers,
  filterRuntimeAppSkillsByRuntimeAvailability,
  resolveAgentSkillEnvironment,
  resolveAgentSkills,
} from "./skills.ts";
import { buildTaskPromptWithDocumentContexts, contextsFromLegacyDocuments } from "./prompt.ts";
import type { RouterSessionPromptContext } from "./prompt-lines.ts";

export interface PreparedDaemonTaskContext {
  prompt: string;
  payload: ParsedTaskPayload;
  agentProfile?: ActiveEmployee;
  agentSkills: WorkspaceSkill[];
  agentKnowledgePages: KnowledgePage[];
  runtimeApps: RuntimeAppContextEntry[];
  /** Non-secret MCP manifest for a future task-scoped gateway. */
  mcpConnections: RuntimeMcpConnectionContextEntry[];
  agentDocumentContexts: AgentDocumentContext[];
  feishuLarkCliResourceGrants: FeishuLarkCliResourceGrant[];
  agentNotifications: WorkspaceNotificationRecord[];
  attachmentLines: string[];
  skillContextDir?: string;
  providerSkillContextDir?: string;
  channelDocumentsContextDir?: string;
  knowledgeContextDir?: string;
  skillEnv: Record<string, string>;
  skillEnvConflicts: string[];
  skillReadinessBlockers: string[];
  /**
   * Frozen per-task Skill execution snapshot: which installation revisions this
   * task was prepared against. Persisted on the task for audit; used to drive
   * materialization so a mid-flight upgrade cannot drift the artifact.
   */
  skillExecutionSnapshot?: TaskSkillExecutionSnapshot;
  /** Unanimously-declared project working dir for this employee's skills, if any. */
  projectWorkDir?: string;
}

export class WorkspaceMaterializationIncompleteError extends Error {
  readonly code = "workspace.materialization_incomplete";
  readonly missingBlobs: number;

  constructor(input: { employeeName: string; missingBlobs: number }) {
    super(
      `${input.missingBlobs} head blob(s) could not be restored for employee "${input.employeeName}".`,
    );
    this.name = "WorkspaceMaterializationIncompleteError";
    this.missingBlobs = input.missingBlobs;
  }
}

export function prepareDaemonTaskContext(input: {
  runtime: AgentRuntimeRecord;
  task: QueuedTaskRecord;
  workDir: string;
  agentProfile?: ActiveEmployee;
  channelDocuments?: ChannelDocument[];
  agentDocumentContexts?: AgentDocumentContext[];
  contactContext?: ContactAgentContext;
  payloadOverride?: Partial<ParsedTaskPayload>;
  routerSessionContext?: RouterSessionPromptContext;
  feishuLarkCliResourceGrants?: FeishuLarkCliResourceGrant[];
  /** The remote input-bundle route transports the durable head as blob refs. */
  skipWorkspaceMaterialization?: boolean;
}): PreparedDaemonTaskContext {
  const payload = {
    ...parseTaskPayload(input.task),
    ...(input.payloadOverride ?? {}),
  } satisfies ParsedTaskPayload;
  // Restore the employee's durable workspace head into the workDir first so a
  // fresh runtime is seeded with committed files; per-task input (bundle,
  // attachments, skills) overlays on top. Skips existing paths so a persistent
  // conversation workDir is never clobbered by an older snapshot.
  const materializeResult = input.skipWorkspaceMaterialization
    ? { materializedFiles: 0, missingBlobs: 0 }
    : materializeHeadRevisionToWorkDir(input.workDir, {
        workspaceId: input.task.workspaceId,
        employeeName: input.task.agentId,
      });
  if (materializeResult.missingBlobs > 0) {
    // Never run or commit against a partial durable head. Continuing here would
    // make the next workDir diff interpret unreadable files as intentional
    // tombstones and could promote storage damage into a valid new revision.
    throw new WorkspaceMaterializationIncompleteError({
      employeeName: payload.assignee ?? input.task.agentId,
      missingBlobs: materializeResult.missingBlobs,
    });
  }
  const attachmentLines = materializeAttachments(payload.attachments, input.workDir);
  const workspaceState = readWorkspaceStateSync(input.task.workspaceId);
  const runtimeApps = listRuntimeAppContextEntriesForRuntimeSync({
    workspaceId: input.task.workspaceId,
    runtimeId: input.runtime.id,
  });
  const mcpConnections = listReadyMcpConnectionsForTaskSync({
    workspaceId: input.task.workspaceId,
    runtimeId: input.runtime.id,
  });
  const agentDocumentContexts = input.agentDocumentContexts ?? contextsFromLegacyDocuments(input.channelDocuments ?? []);
  const feishuLarkCliResourceGrants = input.feishuLarkCliResourceGrants ?? [];
  const agentName = payload.assignee ?? input.task.agentId;
  const agentNotifications = resolveAgentNotificationsForTask({
    workspaceId: input.task.workspaceId,
    agentName,
    task: input.task,
    payload,
    agentDocumentContexts,
  });
  const documentPermissionRequests = listDocumentPermissionRequestsSync({
    workspaceId: input.task.workspaceId,
    requestedByAgentName: agentName,
  }).filter((request) => request.status === "pending" || request.status === "rejected");
  let agentSkills = resolveAgentSkills(workspaceState, input.agentProfile, input.task.workspaceId);
  agentSkills = filterRuntimeAppSkillsByRuntimeAvailability(agentSkills, runtimeApps);
  const agentKnowledgePages = resolveAgentKnowledgePages(workspaceState, input.agentProfile, input.task.workspaceId);
  // Resolve (or reuse the persisted) Skill execution snapshot: the frozen
  // artifact-digest pins for this task's skills on this runtime. Materialization
  // uses ONLY these digests so a mid-flight upgrade/rollback cannot drift the
  // artifact a running task executes against (02-架构设计.md §6).
  const skillExecutionSnapshot = resolveOrLoadTaskSkillExecutionSnapshotSync(input.task.id, {
    workspaceId: input.task.workspaceId,
    runtimeId: input.runtime.id,
    agentName,
    agentSkills,
  });
  const digestBySkillId = new Map<string, string>(
    skillExecutionSnapshot.entries.map((entry) => [entry.skillId, entry.artifactDigest]),
  );
  const skillDirectories = materializeAgentSkills(
    agentSkills,
    input.workDir,
    input.runtime.provider,
    digestBySkillId,
    input.task.workspaceId,
  );
  const { env: skillEnv, conflicts: skillEnvConflicts } = resolveAgentSkillEnvironment(
    input.task.workspaceId,
    agentName,
    agentSkills,
  );
  const skillReadinessBlockers = collectSkillReadinessBlockers(
    input.task.workspaceId,
    agentName,
    agentSkills,
    input.runtime.id,
    input.runtime.provider,
    buildRuntimeCapabilityIds(runtimeApps),
    skillExecutionSnapshot,
  );
  const knowledgeContextDir = materializeAgentKnowledgePages(agentKnowledgePages, input.workDir);
  const channelDocumentsContextDir =
    agentDocumentContexts.length > 0
      ? materializeChannelDocuments(agentDocumentContexts, input.workDir, input.task.workspaceId)
      : undefined;

  const projectWorkDir = resolveSkillProjectWorkDirSync(input.task.workspaceId, agentName);

  return {
    prompt: buildTaskPromptWithDocumentContexts(
      input.runtime,
      payload,
      attachmentLines,
      input.agentProfile,
      agentSkills,
      skillDirectories.compatibilityDir,
      skillDirectories.nativeDir,
      agentDocumentContexts,
      channelDocumentsContextDir,
      input.contactContext,
      { pages: agentKnowledgePages, contextDir: knowledgeContextDir },
      runtimeApps,
      feishuLarkCliResourceGrants,
      documentPermissionRequests,
      agentNotifications,
      input.routerSessionContext,
      projectWorkDir,
    ),
    payload,
    agentProfile: input.agentProfile,
    agentSkills,
    agentKnowledgePages,
    runtimeApps,
    mcpConnections,
    agentDocumentContexts,
    feishuLarkCliResourceGrants,
    agentNotifications,
    attachmentLines,
    skillContextDir: skillDirectories.compatibilityDir,
    providerSkillContextDir: skillDirectories.nativeDir,
    channelDocumentsContextDir,
    knowledgeContextDir,
    skillEnv,
    skillEnvConflicts,
    skillReadinessBlockers,
    skillExecutionSnapshot,
    projectWorkDir,
  };
}
