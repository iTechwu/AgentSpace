import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChannelSync,
  createChannelDocumentSync,
  createEmployeeSync,
  deleteEmployeeSync,
  ensureDirectChannelSync,
  initializeOrganizationSync,
  postMessageSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
} from "@dofe-agent/services";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-direct-channel-cleanup-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "general",
  });
});

describe("deleteEmployeeSync", () => {
  it("removes direct-channel artifacts while preserving shared group channels", () => {
    createEmployeeSync({
      name: "Planner",
      role: "Planner",
    });
    createChannelSync({
      name: "trip-room",
      humanMemberNames: ["techwu"],
      employeeNames: ["Planner"],
    });
    const { channelName: directChannelName } = ensureDirectChannelSync({
      humanMemberName: "techwu",
      employeeName: "Planner",
    });

    postMessageSync({
      channel: directChannelName,
      speaker: "techwu",
      role: "human",
      summary: "先整理大阪行程。",
    });
    createChannelDocumentSync({
      channelName: directChannelName,
      title: "大阪行程草案",
      contentMarkdown: "Day 1",
      createdBy: "techwu",
      createdByType: "human",
    });

    deleteEmployeeSync("Planner");

    const state = readWorkspaceStateSync();
    expect(state.channels.some((channel) => channel.name === directChannelName)).toBe(false);
    expect(state.messages.some((message) => message.channel === directChannelName)).toBe(false);
    expect(state.channelDocuments.some((document) => document.channelName === directChannelName)).toBe(false);

    const groupChannel = state.channels.find((channel) => channel.name === "trip-room");
    expect(groupChannel).toBeTruthy();
    expect(groupChannel?.employeeNames).toEqual([]);
  });
});
