import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultWorkspaceState, type ActiveEmployee } from "@dofe-agent/domain/workspace";
import { addChannelEmployeesToState, removeChannelArtifactsFromState } from "./channels.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-channels-state-"));

function buildEmployee(name: string, channels: string[] = []): ActiveEmployee {
  return {
    name,
    role: "Agent",
    remarkName: name,
    origin: "manual",
    summary: `${name} test agent`,
    traits: [],
    fit: "Test fixture",
    skillIds: [],
    channels,
    status: "active",
  };
}

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("removeChannelArtifactsFromState removes conversation execution workspaces for the deleted channel", () => {
  const state = createDefaultWorkspaceState();
  state.channels.push({
    name: "travel",
    kind: "group",
    humanMemberNames: [],
    humanMembers: 0,
    employeeNames: ["Planner"],
  });
  state.messages.push({
    id: "msg-1",
    channel: "travel",
    speaker: "Planner",
    role: "agent",
    time: "10:00",
    summary: "hello",
    status: "completed",
    kind: "message",
  });
  state.conversationExecutionWorkspaces = [
    {
      conversationKey: "group:travel:Planner",
      conversationKind: "group",
      channelName: "travel",
      agentId: "Planner",
      updatedAt: "2026-04-28T00:00:00.000Z",
      workDir: "/tmp/travel",
    },
    {
      conversationKey: "group:ops:Planner",
      conversationKind: "group",
      channelName: "ops",
      agentId: "Planner",
      updatedAt: "2026-04-28T00:00:00.000Z",
      workDir: "/tmp/ops",
    },
  ];

  removeChannelArtifactsFromState(state, "travel");

  assert.equal(state.channels.some((channel) => channel.name === "travel"), false);
  assert.equal(state.messages.some((message) => message.channel === "travel"), false);
  assert.deepEqual(
    state.conversationExecutionWorkspaces?.map((workspace) => workspace.conversationKey),
    ["group:ops:Planner"],
  );
});

test("addChannelEmployeesToState adds agents to a group channel and employee memberships", () => {
  const state = createDefaultWorkspaceState();
  state.activeEmployees = [buildEmployee("Atlas", ["ops"]), buildEmployee("Vega")];
  state.channels = [{
    name: "ops",
    kind: "group",
    humanMemberNames: [],
    humanMembers: 0,
    employeeNames: ["Atlas"],
  }];

  const channel = addChannelEmployeesToState(state, {
    channelName: "ops",
    employeeNames: [" Vega ", "Atlas"],
  });

  assert.deepEqual(channel.employeeNames, ["Atlas", "Vega"]);
  assert.deepEqual(
    state.activeEmployees.find((employee) => employee.name === "Atlas")?.channels,
    ["ops"],
  );
  assert.deepEqual(
    state.activeEmployees.find((employee) => employee.name === "Vega")?.channels,
    ["ops"],
  );
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
