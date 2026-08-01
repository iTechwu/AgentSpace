import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before } from "node:test";
import { createDefaultWorkspaceState } from "@dofe-agent/domain/workspace";
import {
  buildConversationExecutionWorkspaceKey,
  readConversationExecutionWorkspaceState,
  resolveConversationExecutionWorkspacePath,
  upsertConversationExecutionWorkspaceState,
} from "./conversation-execution-workspaces.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-conversation-execution-"));
const resolvedTempRoot = realpathSync(tempRoot);

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("buildConversationExecutionWorkspaceKey distinguishes direct and group workspaces", () => {
  assert.equal(
    buildConversationExecutionWorkspaceKey({
      conversationKind: "direct",
      channelName: "direct-atlas",
      agentId: "Atlas",
    }),
    "direct:direct-atlas:Atlas",
  );
  assert.equal(
    buildConversationExecutionWorkspaceKey({
      conversationKind: "group",
      channelName: "mission-control",
      agentId: "Atlas",
    }),
    "group:mission-control:Atlas",
  );
});

test("upsertConversationExecutionWorkspaceState stores and updates canonical conversation state", () => {
  const state = createDefaultWorkspaceState();

  const created = upsertConversationExecutionWorkspaceState(state, {
    channelName: "direct-atlas",
    agentId: "Atlas",
    contactId: "Atlas",
    sessionId: "session-1",
    workDir: "/tmp/direct-atlas",
    lastTaskQueueId: "queue-1",
    lastError: null,
    updatedAt: "2026-04-28T00:00:00.000Z",
  });

  assert.equal(created.conversationKind, "direct");
  assert.equal(state.conversationExecutionWorkspaces?.length, 1);
  assert.equal(state.conversationExecutionWorkspaces?.[0]?.sessionId, "session-1");

  const updated = upsertConversationExecutionWorkspaceState(state, {
    channelName: "direct-atlas",
    agentId: "Atlas",
    contactId: "Atlas",
    workDir: "/tmp/direct-atlas",
    lastTaskQueueId: "queue-2",
    lastError: "provider failed",
    updatedAt: "2026-04-28T01:00:00.000Z",
  });

  assert.equal(updated.sessionId, "session-1");
  assert.equal(updated.lastTaskQueueId, "queue-2");
  assert.equal(updated.lastError, "provider failed");
  assert.equal(state.conversationExecutionWorkspaces?.length, 1);
});

test("upsertConversationExecutionWorkspaceState clears nullable session and workDir fields explicitly", () => {
  const state = createDefaultWorkspaceState();

  upsertConversationExecutionWorkspaceState(state, {
    channelName: "mission-control",
    agentId: "Hermes",
    sessionId: "session-1",
    workDir: "/tmp/mission-control",
    lastTaskQueueId: "queue-1",
  });

  const updated = upsertConversationExecutionWorkspaceState(state, {
    channelName: "mission-control",
    agentId: "Hermes",
    sessionId: null,
    workDir: null,
    lastTaskQueueId: "queue-2",
  });

  assert.equal(updated.sessionId, undefined);
  assert.equal(updated.workDir, undefined);
  assert.equal(updated.lastTaskQueueId, "queue-2");
});

test("readConversationExecutionWorkspaceState falls back to legacy direct conversation state", () => {
  const state = createDefaultWorkspaceState();
  state.directConversations.push({
    contactId: "Atlas",
    humanMemberName: "techwu",
    sessionId: "legacy-session",
    workDir: "/tmp/legacy-atlas",
    updatedAt: "2026-04-28T00:00:00.000Z",
  });

  const workspace = readConversationExecutionWorkspaceState(state, {
    channelName: "direct-atlas",
    agentId: "Atlas",
    contactId: "Atlas",
  });

  assert.equal(workspace?.conversationKind, "direct");
  assert.equal(workspace?.sessionId, "legacy-session");
  assert.equal(workspace?.workDir, "/tmp/legacy-atlas");
});

test("resolveConversationExecutionWorkspacePath uses the conversation-scoped daemon channel root", () => {
  assert.equal(
    resolveConversationExecutionWorkspacePath({
      workspaceId: "workspace-mars",
      channelName: "Mission Control",
      agentId: "Atlas Planner",
    }),
    join(
      resolvedTempRoot,
      "data",
      "daemon",
      "workspaces",
      "workspace-mars",
      "workdirs",
      "channels",
      "Mission-Control",
      "Atlas-Planner",
    ),
  );
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
