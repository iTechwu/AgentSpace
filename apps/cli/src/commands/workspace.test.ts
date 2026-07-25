import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import type { ActiveEmployee, ChannelRecord } from "@dofe-agent/domain/workspace";
import {
  BUILTIN_GOOGLE_WORKSPACE_CLI_SKILL_NAME,
  BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME,
  createEmployeeSync,
  initializeOrganizationSync,
  listWorkspaceSkillsSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "@dofe-agent/services";
import { runWorkspaceCommand } from "./workspace.ts";

const originalCwd = process.cwd();
const originalAgentEnv = process.env.DOFE_AGENT_CONTEXT_AGENT_NAME;
const originalTaskEnv = process.env.DOFE_AGENT_CONTEXT_TASK_ID;
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-workspace-command-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("workspace context resolve-entity infers the current agent from runtime env", () => {
  seedWorkspace();
  process.env.DOFE_AGENT_CONTEXT_AGENT_NAME = "Test";
  delete process.env.DOFE_AGENT_CONTEXT_TASK_ID;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(typeof value === "string" ? value : String(value));
  };

  try {
    const exitCode = runWorkspaceCommand("context", ["resolve-entity", "--query", "个人助手"], "json");
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(logs.join("\n")) as { name: string };
  assert.equal(payload.name, "techwu's assistant");
});

test("workspace initialization includes the builtin workspace-context skill", () => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });

  assert.ok(listWorkspaceSkillsSync().some((skill) => skill.name === BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME));
  assert.ok(listWorkspaceSkillsSync().some((skill) => skill.name === BUILTIN_GOOGLE_WORKSPACE_CLI_SKILL_NAME));
});

test("workspace context command refuses to run without runtime context", () => {
  delete process.env.DOFE_AGENT_CONTEXT_AGENT_NAME;
  delete process.env.DOFE_AGENT_CONTEXT_TASK_ID;

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (value?: unknown) => {
    errors.push(typeof value === "string" ? value : String(value));
  };

  try {
    const exitCode = runWorkspaceCommand("context", ["list-entities"], "json");
    assert.equal(exitCode, 1);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join("\n"), /only available inside an agent task runtime/i);
});

function seedWorkspace(): void {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });

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
    messages: [
      {
        id: "message-1",
        channel: "tour visit",
        speaker: "你",
        role: "human",
        time: "15:09",
        summary: "@个人助手 你看一下这个文件。",
        status: "completed",
        mentions: [
          {
            agentId: "techwu's assistant",
            label: "个人助手",
            token: "个人助手",
            mentionType: "agent",
            inChannel: true,
          },
        ],
      },
    ],
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
  state.activeEmployees = state.activeEmployees.map((employee: ActiveEmployee) =>
    employee.name === "Test" || employee.name === "techwu's assistant"
      ? {
          ...employee,
          channels: ["tour visit"],
        }
      : employee,
  );
  state.channels = state.channels.map((channel: ChannelRecord) =>
    channel.name === "tour visit"
      ? {
          ...channel,
          employeeNames: ["Test", "techwu's assistant"],
        }
      : channel,
  );
  writeWorkspaceStateSync(state);
}

test.after(() => {
  process.chdir(originalCwd);
  if (originalAgentEnv) {
    process.env.DOFE_AGENT_CONTEXT_AGENT_NAME = originalAgentEnv;
  } else {
    delete process.env.DOFE_AGENT_CONTEXT_AGENT_NAME;
  }
  if (originalTaskEnv) {
    process.env.DOFE_AGENT_CONTEXT_TASK_ID = originalTaskEnv;
  } else {
    delete process.env.DOFE_AGENT_CONTEXT_TASK_ID;
  }
});
