import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  buildContactAgentContextSync,
  createEmployeeSync,
  initializeOrganizationSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  resolveWorkspaceContextEntitySync,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-context-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("buildContactAgentContextSync exposes shared channels, observed labels, and recent interactions", () => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });

  writeWorkspaceStateSync({
    ...buildBaseState(),
    messages: [
      {
        id: "message-3",
        channel: "tour visit",
        speaker: "techwu's assistant",
        role: "agent",
        time: "15:13",
        summary: "@Test 你接着帮我看下这版动线还有没有隐藏折返。",
        status: "completed",
        mentions: [
          {
            agentId: "Test",
            label: "Test",
            token: "Test",
            mentionType: "agent",
            inChannel: true,
          },
        ],
      },
      {
        id: "message-2",
        channel: "tour visit",
        speaker: "你",
        role: "human",
        time: "15:09",
        summary: "@个人助手 你看一下这个文件，然后 @Test 你检查一下。",
        status: "completed",
        mentions: [
          {
            agentId: "techwu's assistant",
            label: "个人助手",
            token: "个人助手",
            mentionType: "agent",
            inChannel: true,
          },
          {
            agentId: "Test",
            label: "Test",
            token: "Test",
            mentionType: "agent",
            inChannel: true,
          },
        ],
      },
    ],
  });

  const context = buildContactAgentContextSync("Test");
  const assistant = context.knownEntities.find((entity) => entity.name === "techwu's assistant");

  assert.equal(context.self.name, "Test");
  assert.deepEqual(context.self.channels, ["tour visit"]);
  assert.ok(assistant);
  assert.deepEqual(assistant?.sharedChannels, ["tour visit"]);
  assert.deepEqual(assistant?.observedLabels, ["个人助手"]);
  assert.equal(assistant?.recentSharedInteractionChannel, "tour visit");
  assert.equal(assistant?.recentSharedInteractionTime, "15:13");
  assert.match(assistant?.recentSharedInteractionSummary ?? "", /隐藏折返/);
});

test("resolveWorkspaceContextEntitySync matches observed labels from visible history", () => {
  const entity = resolveWorkspaceContextEntitySync("Test", "个人助手");

  assert.equal(entity?.name, "techwu's assistant");
  assert.equal(entity?.relationship, "workspace-collaborator");
});

function buildBaseState() {
  writeWorkspaceStateSync({
    ...resetWorkspaceStateSync(),
    organizationName: "Northstar Labs",
    pendingHandoffs: 0,
    humanMembers: [{ name: "techwu", role: "Founder" }],
    activeEmployees: [],
    directConversations: [],
    channels: [
      {
        name: "tour visit",
        humanMembers: 1,
        employeeNames: ["Test", "techwu's assistant"],
      },
    ],
    channelDocuments: [],
    channelDocumentVersions: [],
    channelDocumentBlocks: [],
    channelDocumentAccesses: [],
    channelDocumentChangeSets: [],
    channelDocumentConflicts: [],
    channelDocumentPresences: [],
    channelDocumentRuns: [],
    channelDocumentRunSteps: [],
    materials: [],
    messages: [],
    tasks: [],
    approvals: [],
    ledger: [],
  });
  createEmployeeSync({
    name: "Test",
    role: "Agent",
    remarkName: "Test",
    summary: "Test",
    fit: "Test",
    origin: "seed",
  });
  createEmployeeSync({
    name: "techwu's assistant",
    role: "Assistant",
    remarkName: "个人助手",
    summary: "Personal assistant",
    fit: "Personal assistant",
    origin: "seed",
  });
  const state = readWorkspaceStateSync();
  state.activeEmployees = state.activeEmployees.map((employee) =>
    employee.name === "Test" || employee.name === "techwu's assistant"
      ? {
          ...employee,
          channels: ["tour visit"],
        }
      : employee,
  );
  state.channels = state.channels.map((channel) =>
    channel.name === "tour visit"
      ? {
          ...channel,
          employeeNames: ["Test", "techwu's assistant"],
        }
      : channel,
  );

  return writeWorkspaceStateSync(state);
}

test.after(() => {
  process.chdir(originalCwd);
});
