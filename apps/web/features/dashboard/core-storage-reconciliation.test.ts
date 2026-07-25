import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceStateRecordSync,
  writeWorkspaceStateRecordSync,
} from "@dofe-agent/db";
import {
  createChannelSync,
  createEmployeeSync,
  createTaskSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
} from "@dofe-agent/services";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-core-storage-reconciliation-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("core object storage reconciliation", () => {
  it("does not repair state_json drift from dedicated storage on read", () => {
    createEmployeeSync({
      name: "Planner",
      remarkName: "Planner",
      summary: "Planning agent",
    });
    createChannelSync({
      name: "delivery",
      humanMemberNames: [],
      employeeNames: ["Planner"],
    });
    createTaskSync({
      title: "Prepare launch checklist",
      channel: "delivery",
      assignee: "Planner",
      priority: "medium",
    });

    const persisted = readWorkspaceStateRecordSync();
    expect(persisted).toBeTruthy();

    writeWorkspaceStateRecordSync({
      ...persisted!,
      activeEmployees: [],
      channels: [],
      tasks: [],
    });

    const snapshot = readWorkspaceStateSync();

    expect(snapshot.activeEmployees.map((employee) => employee.name)).not.toContain("Planner");
    expect(snapshot.channels.map((channel) => channel.name)).not.toContain("delivery");
    expect(snapshot.tasks.map((task) => task.title)).not.toContain("Prepare launch checklist");
  });
});
