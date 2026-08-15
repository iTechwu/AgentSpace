import assert from "node:assert/strict";
import test from "node:test";
import {
  bindEmployeeRuntimeSync,
  createStoredEmployeeSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  hardDeleteWorkspaceSync,
  listEmployeeRuntimeBindingsSync,
  listTaskExecutionEventsSync,
  listWorkspaceMembershipsSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  listEmployeeRuntimeBindingsForWorkspaceAsync,
  listTaskExecutionEventsAsync,
  listWorkspaceMembershipsAsync,
} from "./index.ts";

test("Prisma read services preserve the legacy DTO contracts", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspaceId = `workspace-service-cutover-${suffix}`;
  const employeeName = `Service Cutover ${suffix}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Service Cutover ${suffix}`,
    createdBy: "service-cutover-test",
  });
  const user = createUserSync({
    displayName: `Member ${suffix}`,
    primaryEmail: `member-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: user.id, role: "admin" });
  createStoredEmployeeSync({
    id: `employee-${suffix}`,
    name: employeeName,
    role: "Agent",
    origin: "manual",
    summary: "Service cutover fixture",
    traits: [],
    fit: "Ready",
    status: "active",
    instructions: "",
    skillIds: [],
    channels: [],
  }, workspaceId);
  const runtime = registerDaemonRuntimesSync({
    daemonKey: `service-cutover-${suffix}`,
    deviceName: `Service Cutover Device ${suffix}`,
    workspaceId,
    runtimes: [{ provider: "codex", name: `Runtime ${suffix}`, version: "test" }],
  }).runtimes[0]!;
  bindEmployeeRuntimeSync({ workspaceId, employeeName, runtimeId: runtime.id });
  const queuedTask = enqueueNativeTaskSync({
    workspaceId,
    taskId: `issue-${suffix}`,
    assignee: employeeName,
    channel: "general",
    priority: "medium",
    title: "Task started",
  });
  assert.ok(queuedTask);

  try {
    assert.deepEqual(
      await listWorkspaceMembershipsAsync(workspaceId),
      listWorkspaceMembershipsSync(workspaceId),
    );
    assert.deepEqual(
      await listEmployeeRuntimeBindingsForWorkspaceAsync(workspaceId),
      listEmployeeRuntimeBindingsSync(workspaceId),
    );
    const options = { workspaceId, taskId: queuedTask.id, order: "asc" as const };
    assert.deepEqual(
      await listTaskExecutionEventsAsync(options),
      listTaskExecutionEventsSync(options),
    );
  } finally {
    hardDeleteWorkspaceSync(workspaceId);
  }
});
