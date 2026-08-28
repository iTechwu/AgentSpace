import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  getDatabase,
  listStoredEmployeesSync,
  randomLikeId,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  createEmployeeSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
  setEmployeeSkillIdsSync,
  validateWorkflowNodeForDispatchSync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testTosStorage = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  testTosStorage.clear();
});

function createRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'online', ?, ?)`
  ).run(id, `Runtime ${id}`, now, now);
  return id;
}

function buildArtifact(input: {
  name: string;
  skillId?: string;
  coordinate?: string;
  skillDependencies?: Array<{ coordinate: string; version: string; placement: "same_runtime" | "workflow"; required?: boolean }>;
}) {
  return buildAndPersistSkillArtifactSync({
    name: input.name,
    skillId: input.skillId,
    version: "1.0.0",
    files: [{ path: "SKILL.md", bytes: encoder.encode(`---\nname: ${input.name}\n---\n# Body\n`) }],
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo",
    coordinate: input.coordinate,
    ...(input.skillDependencies ? { skillDependencies: input.skillDependencies } : {}),
  });
}

test("dispatch preflight reports workflow_skill_closure_not_ready when the closure is not installed", () => {
  const runtimeId = createRuntime();
  createEmployeeSync({ name: "Planner" }, "default");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Planner", runtimeId });
  const employeeId = listStoredEmployeesSync("default").find((employee) => employee.name === "Planner")?.id;
  assert.ok(employeeId, "employee id resolved");

  const skill = createWorkspaceSkillSync({ name: "novel-script", description: "script" }, "default");
  setEmployeeSkillIdsSync("Planner", [skill.id], "default");

  // Dependency artifact exists (imported by coordinate) but is NOT installed on the runtime.
  buildArtifact({ name: "novel-art", coordinate: "github:owner/repo/skills/novel-art" });

  // Root artifact assigned to the skill (sets active digest) with a workflow dependency.
  buildArtifact({
    name: "novel-script",
    skillId: skill.id,
    coordinate: "github:owner/repo/skills/novel-script",
    skillDependencies: [{ coordinate: "github:owner/repo/skills/novel-art", version: "^1.0.0", placement: "workflow", required: true }],
  });

  const blocker = validateWorkflowNodeForDispatchSync("default", {
    id: "script-node",
    type: "employee_task",
    employeeId,
    config: { requiredSkillIds: [skill.id] },
  });

  assert.equal(blocker?.code, "workflow_skill_closure_not_ready");
});
