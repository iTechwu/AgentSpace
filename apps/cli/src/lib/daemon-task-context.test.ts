import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import type { QueuedTaskRecord } from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import {
  createDocumentPermissionRequestSync,
  createNotificationSync,
  BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME,
  BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME,
  createEmployeeSync,
  createKnowledgePageSync,
  createWorkspaceSkillSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  setKnowledgePageAssignedEmployeesSync,
  setKnowledgePageAssignmentModeSync,
  setEmployeeSkillIdsSync,
} from "@dofe-agent/services";
import {
  createWorkspaceSync,
  createUserSync,
  rejectDocumentPermissionRequestSync,
} from "@dofe-agent/db";
import {
  materializeAgentKnowledgePages,
  materializeAgentSkills,
  parseTaskPayload,
  prepareDaemonTaskContext,
  resolveAgentKnowledgePages,
  resolveAgentSkills,
} from "./daemon-task-context.ts";
import { parseTaskInputJson, resolveConversationThreadId } from "../../../../packages/daemon/src/task-context.ts";

const originalCwd = process.cwd();
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-task-context-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

test("resolveAgentSkills prefers stored agent_skill assignments over stale agentProfile.skillIds", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);

  const workspaceState = readWorkspaceStateSync();
  const staleAgentProfile = {
    ...workspaceState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner")!,
    skillIds: [],
  };

  const resolved = resolveAgentSkills(workspaceState, staleAgentProfile);

  assert.ok(resolved.some((item) => item.id === skill.id));
  assert.ok(resolved.some((item) => item.name === BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME));
  assert.ok(resolved.some((item) => item.name === BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME));
});

test("materializeAgentSkills writes provider-native directories alongside compatibility fallback", () => {
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  const workDir = join(tempRoot, "workdir");
  const result = materializeAgentSkills([skill], workDir, "claude");

  assert.equal(result.compatibilityDir, join(workDir, ".agent_context", "skills"));
  assert.equal(result.nativeDir, join(workDir, ".claude", "skills"));
  assert.equal(result.primaryDir, join(workDir, ".claude", "skills"));
  assert.equal(existsSync(join(result.nativeDir!, `${skill.name}-${skill.id.slice(-6)}`, "SKILL.md")), true);
  assert.match(
    readFileSync(join(result.compatibilityDir!, `${skill.name}-${skill.id.slice(-6)}`, "SKILL.md"), "utf8"),
    /# research-pack/i,
  );
});

test("resolveAgentKnowledgePages includes shared and selected pages for the current agent only", () => {
  createEmployeeSync({ name: "Planner" });
  createEmployeeSync({ name: "Legal" });
  createKnowledgePageSync({ title: "Shared handbook", contentMarkdown: "# Common" });
  createKnowledgePageSync({ title: "Planner playbook", contentMarkdown: "# Plan" });
  createKnowledgePageSync({ title: "Legal memo", contentMarkdown: "# Law" });
  const workspaceState = readWorkspaceStateSync();
  const shared = workspaceState.knowledgePages.find((page) => page.title === "Shared handbook")!;
  const planner = workspaceState.knowledgePages.find((page) => page.title === "Planner playbook")!;
  const legal = workspaceState.knowledgePages.find((page) => page.title === "Legal memo")!;

  setKnowledgePageAssignmentModeSync(planner.id, "selected_agents", "techwu");
  setKnowledgePageAssignedEmployeesSync(planner.id, ["Planner"], "techwu");
  setKnowledgePageAssignmentModeSync(legal.id, "selected_agents", "techwu");

  const nextState = readWorkspaceStateSync();
  const plannerProfile = nextState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner");
  const resolved = resolveAgentKnowledgePages(nextState, plannerProfile);

  assert.deepEqual(resolved.map((page) => page.id).sort(), [shared.id, planner.id].sort());
});

test("materializeAgentKnowledgePages writes manifest and markdown files", () => {
  const pages = [
    {
      id: "knowledge-page-1",
      parentId: null,
      title: "Planner Playbook",
      contentMarkdown: "# Planner",
      sortOrder: 0,
      tags: ["planning"],
      createdBy: "techwu",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
      assignmentMode: "selected_agents" as const,
    },
  ];
  const workDir = join(tempRoot, "knowledge-workdir");
  const contextDir = materializeAgentKnowledgePages(pages, workDir);

  assert.equal(contextDir, join(workDir, ".agent_context", "knowledge"));
  assert.equal(existsSync(join(contextDir!, "manifest.json")), true);
  assert.match(readFileSync(join(contextDir!, "manifest.json"), "utf8"), /Planner Playbook/);
  assert.match(readFileSync(join(contextDir!, "pages", "01-Planner-Playbook-page-1.md"), "utf8"), /# Planner/);
});

test("prepareDaemonTaskContext materializes agent knowledge and mentions it in the prompt", () => {
  createEmployeeSync({ name: "Planner" });
  createKnowledgePageSync({ title: "Shared handbook", contentMarkdown: "# Common" });
  const workspaceState = readWorkspaceStateSync();
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner");
  const workDir = join(tempRoot, "prepared-knowledge-workdir");
  const context = prepareDaemonTaskContext({
    runtime: {
      id: "runtime-1",
      workspaceId: "default",
      provider: "codex",
      name: "Codex",
      version: "1",
      status: "online",
      deviceInfo: "",
      metadataJson: "{}",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    task: {
      id: "queue-1",
      workspaceId: "default",
      agentId: "Planner",
      runtimeId: "runtime-1",
      triggerType: "manual",
      priority: 1,
      status: "queued",
      inputJson: JSON.stringify({ title: "Use knowledge" }),
      queuedAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    } satisfies QueuedTaskRecord,
    workDir,
    agentProfile,
  });

  assert.equal(context.agentKnowledgePages.length, 1);
  assert.equal(existsSync(join(context.knowledgeContextDir!, "manifest.json")), true);
  assert.match(context.prompt, /当前 Agent 可用知识页: 1 篇/);
  assert.match(context.prompt, /Shared handbook/);
  assert.match(context.prompt, /dofe-agent output knowledge propose-create\/propose-update/);
  assert.match(context.prompt, /不要手写 runtime-output\/knowledge-proposals\.json/);
});

test("prepareDaemonTaskContext does not inject retired Google Workspace skills", () => {
  createEmployeeSync({ name: "Planner" });
  const workspaceState = readWorkspaceStateSync();
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner");
  const workDir = join(tempRoot, "prepared-google-workspace-workdir");
  const context = prepareDaemonTaskContext({
    runtime: {
      id: "runtime-1",
      workspaceId: "default",
      provider: "codex",
      name: "Codex",
      version: "1",
      status: "online",
      deviceInfo: "",
      metadataJson: "{}",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    task: {
      id: "queue-1",
      workspaceId: "default",
      agentId: "Planner",
      runtimeId: "runtime-1",
      triggerType: "channel_chat",
      priority: 1,
      status: "queued",
      inputJson: JSON.stringify({
        assignee: "Planner",
        channelName: "research",
        channelMessage: "Read the sheet",
      }),
      queuedAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    } satisfies QueuedTaskRecord,
    workDir,
    agentProfile,
    channelDocuments: [
      {
        id: "doc-sheet-1",
        channelName: "research",
        title: "Competitors",
        slug: "competitors",
        kind: "sheet",
        storageMode: "external",
        externalProvider: "google_workspace",
        externalFileId: "google-file-1",
        externalUrl: "https://docs.google.com/spreadsheets/d/google-file-1/edit",
        externalSyncStatus: "ok",
        status: "active",
        currentVersionId: "version-1",
        summary: "Competitor research",
        lastEditorType: "human",
        createdBy: "techwu",
        updatedBy: "techwu",
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z",
      },
    ],
  });

  assert.equal(context.agentSkills.some((skill) => skill.name === "google-workspace-cli"), false);
  assert.doesNotMatch(context.prompt, /\bgws\b/i);
});

test("prepareDaemonTaskContext includes rejected document permission requests", () => {
  createEmployeeSync({ name: "Planner" });
  const decider = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  const request = createDocumentPermissionRequestSync({
    workspaceId: "default",
    externalProvider: "google_workspace",
    externalFileId: "sheet-1",
    externalUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
    requestedRole: "forwarder",
    requestedByAgentName: "Planner",
    requestedForChannelName: "research",
    reason: "Need to share it with research.",
  });
  rejectDocumentPermissionRequestSync({
    requestId: request.id,
    decidedByUserId: decider.id,
    decisionNote: "Use the exported summary instead.",
  });
  const workspaceState = readWorkspaceStateSync();
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner");
  const workDir = join(tempRoot, "prepared-document-rejection-workdir");

  const context = prepareDaemonTaskContext({
    runtime: {
      id: "runtime-1",
      workspaceId: "default",
      provider: "codex",
      name: "Codex",
      version: "1",
      status: "online",
      deviceInfo: "",
      metadataJson: "{}",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    task: {
      id: "queue-1",
      workspaceId: "default",
      agentId: "Planner",
      runtimeId: "runtime-1",
      triggerType: "channel_chat",
      priority: 1,
      status: "queued",
      inputJson: JSON.stringify({
        assignee: "Planner",
        channelName: "research",
        channelMessage: "Can you share that sheet here?",
      }),
      queuedAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    } satisfies QueuedTaskRecord,
    workDir,
    agentProfile,
  });

  assert.match(context.prompt, /已有的文档权限申请状态/);
  assert.match(context.prompt, /rejected \| role forwarder \| target https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-1\/edit \| channel research/);
  assert.match(context.prompt, /Use the exported summary instead/);
});

test("prepareDaemonTaskContext includes unread agent notifications related to the current task", () => {
  const workspace = createWorkspaceSync({
    slug: `agent-notifications-${Math.random().toString(36).slice(2)}`,
    name: "Agent Notifications",
    createdBy: "system",
  });
  resetWorkspaceStateSync(workspace.id);
  createEmployeeSync({ name: "Planner" }, workspace.id);
  createNotificationSync({
    workspaceId: workspace.id,
    recipientType: "agent",
    recipientId: "Planner",
    actorType: "human",
    actorId: "user-1",
    type: "document.agent_access_granted",
    resourceType: "document",
    resourceId: "doc-current",
    channelName: "research",
    title: "Document access granted",
    body: "Planner can now use editor access on \"Research Plan\".",
    severity: "success",
  });
  createNotificationSync({
    workspaceId: workspace.id,
    recipientType: "agent",
    recipientId: "Planner",
    actorType: "human",
    actorId: "user-1",
    type: "document.agent_access_granted",
    resourceType: "document",
    resourceId: "doc-unrelated",
    channelName: "finance",
    title: "Document access granted",
    body: "Planner can now use editor access on \"Finance Plan\".",
    severity: "success",
  });
  const workspaceState = readWorkspaceStateSync(workspace.id);
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) => employee.name === "Planner");
  const workDir = join(tempRoot, "prepared-agent-notifications-workdir");

  const context = prepareDaemonTaskContext({
    runtime: {
      id: "runtime-1",
      workspaceId: workspace.id,
      provider: "codex",
      name: "Codex",
      version: "1",
      status: "online",
      deviceInfo: "",
      metadataJson: "{}",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
    task: {
      id: "queue-1",
      workspaceId: workspace.id,
      agentId: "Planner",
      runtimeId: "runtime-1",
      triggerType: "channel_chat",
      priority: 1,
      status: "queued",
      inputJson: JSON.stringify({
        assignee: "Planner",
        channelName: "research",
        channelMessage: "Can you edit the plan now?",
      }),
      queuedAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    } satisfies QueuedTaskRecord,
    workDir,
    agentProfile,
  });

  assert.equal(context.agentNotifications.length, 1);
  assert.match(context.prompt, /当前任务相关的未读 Agent 通知/);
  assert.match(context.prompt, /Planner can now use editor access on "Research Plan"\./);
  assert.doesNotMatch(context.prompt, /Finance Plan/);
});

test("parseTaskPayload ignores legacy channel workdir metadata", () => {
  const payload = parseTaskPayload({
    id: "queue-1",
    workspaceId: "default",
    agentId: "Planner",
    runtimeId: "runtime-1",
    triggerType: "channel_chat",
    priority: 2,
    status: "queued",
    inputJson: JSON.stringify({
      channelName: "mars-ops",
      channelSessionId: "session-1",
      channelWorkDir: "/tmp/legacy-workdir",
      sourceTaskQueueId: "queue-source",
      mentionSource: "agent_output",
      initiatorAgentId: "Atlas",
      mentionCascadeDepth: 1,
      mentionRootMessageId: "message-root",
    }),
    queuedAt: "2026-04-27T00:00:00.000Z",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  } satisfies QueuedTaskRecord);

  assert.equal(payload.channelName, "mars-ops");
  assert.equal(payload.channelSessionId, "session-1");
  assert.equal(payload.sourceTaskQueueId, "queue-source");
  assert.equal(payload.mentionSource, "agent_output");
  assert.equal(payload.initiatorAgentId, "Atlas");
  assert.equal(payload.mentionCascadeDepth, 1);
  assert.equal(payload.mentionRootMessageId, "message-root");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "channelWorkDir"), false);
});


test("parseTaskInputJson and resolveConversationThreadId derive a stable conversation key for direct/group chat tasks", () => {
  const directPayload = parseTaskInputJson(JSON.stringify({
    contactId: "Atlas",
    channelName: "direct-atlas-1",
    channel: "direct-atlas-1",
  }));
  const mentionPayload = parseTaskInputJson(JSON.stringify({
    channelName: "Mission Control",
    channel: "Mission Control",
  }));
  const manualPayload = parseTaskInputJson(JSON.stringify({
    channel: "Mission Control",
  }));

  assert.equal(resolveConversationThreadId({
    triggerType: "channel_chat",
    payload: directPayload,
  }), "direct-atlas-1");
  assert.equal(resolveConversationThreadId({
    triggerType: "mention_chat",
    payload: mentionPayload,
  }), "Mission Control");
  assert.equal(resolveConversationThreadId({
    triggerType: "manual",
    payload: {
      contactId: "Atlas",
      channel: "direct-atlas-1",
    },
  }), "direct-atlas-1");
  assert.equal(resolveConversationThreadId({
    triggerType: "manual",
    payload: manualPayload,
  }), undefined);
});

test.after(() => {
  process.chdir(originalCwd);
});
