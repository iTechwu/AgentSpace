import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  appendTaskMessageSync,
  bindEmployeeRuntimeSync,
  cancelQueuedTaskSync,
  claimNextQueuedTaskForRuntimeSync,
  completeQueuedTaskSync,
  enqueueNativeTaskSync,
  failQueuedTaskSync,
  listTaskExecutionEventsSync,
  registerDaemonRuntimesSync,
  startQueuedTaskSync,
  updateAgentRuntimeManagedFieldsSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-task-events-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

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
  const db = getDatabase();
  db.exec("DELETE FROM task_execution_event");
  db.exec("DELETE FROM task_message");
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
});

test("records lifecycle, tool, message, and artifact execution events", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Draft launch plan",
    channel: "general",
    priority: "high",
    taskId: "task-launch",
  });
  assert.ok(queued);

  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);
  appendTaskMessageSync({ taskId: queued.id, type: "tool_use", tool: "exec_command", content: "bash: npm test" });
  appendTaskMessageSync({ taskId: queued.id, type: "tool_result", tool: "exec_command", content: "tests passed" });
  appendTaskMessageSync({ taskId: queued.id, type: "text", content: "Launch plan ready." });
  completeQueuedTaskSync({
    taskId: queued.id,
    resultJson: {
      output: "Launch plan ready.",
      attachments: [{ id: "att-launch", fileName: "launch-plan.md", mediaType: "text/markdown", sizeBytes: 128 }],
      documentUpdates: [{ documentId: "doc-launch", documentVersionId: "ver-launch" }],
    },
    sessionId: "session-1",
    workDir: "/tmp/work",
  });

  const events = listTaskExecutionEventsSync({ taskId: queued.id });
  assert.deepEqual(events.map((event) => event.type), [
    "queued",
    "assigned",
    "workspace_prepared",
    "tool_started",
    "tool_finished",
    "message_posted",
    "artifact_detected",
    "artifact_collected",
    "artifact_collected",
    "completed",
  ]);
  assert.equal(events[0]?.channelName, "general");
  assert.equal(events[0]?.agentId, "Atlas");
  const attachmentEvent = events.find((event) => event.title.includes("launch-plan.md"));
  assert.ok(attachmentEvent);
  const data = JSON.parse(attachmentEvent.dataJson) as { artifactKind?: string; targetHref?: string };
  assert.equal(data.artifactKind, "attachment");
  assert.equal(data.targetHref, "/api/attachments/att-launch");
});

test("records actionable provider failures as blocked events with structured metadata", () => {
  createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Read private sheet",
    channel: "general",
    priority: "medium",
  });
  assert.ok(queued);

  failQueuedTaskSync({
    taskId: queued.id,
    errorText: "OpenClaw auth profile is missing.",
    errorCode: "provider.profile_missing",
    errorCategory: "profile",
    provider: "openclaw",
    rawProviderMessage: "profile missing at /tmp/work/agent/auth-profiles.json",
  });

  const failure = listTaskExecutionEventsSync({ taskId: queued.id }).at(-1);
  assert.equal(failure?.type, "blocked");
  assert.equal(failure?.severity, "error");
  const data = JSON.parse(failure!.dataJson) as { errorCode?: string; provider?: string };
  assert.equal(data.errorCode, "provider.profile_missing");
  assert.equal(data.provider, "openclaw");
});

test("cancels a running task and records the stopped lifecycle", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Long analysis",
    channel: "general",
    priority: "medium",
  });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);

  const cancelled = cancelQueuedTaskSync({ taskId: queued.id });

  assert.equal(cancelled.status, "cancelled");
  const event = listTaskExecutionEventsSync({ taskId: queued.id }).at(-1);
  assert.equal(event?.type, "cancelled");
  assert.equal(event?.summary, "The running task was stopped.");
});

test("managed runtimes pause task claims while credential recovery needs work", () => {
  const runtimeId = createRuntimeAndBinding();
  updateAgentRuntimeManagedFieldsSync({
    runtimeId,
    provisioningState: "credential_recovering",
    managedCredentialId: "rtc-recovering",
    status: "offline",
  });
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Wait for credential recovery",
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);

  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId), null);

  updateAgentRuntimeManagedFieldsSync({ runtimeId, provisioningState: "needs_attention" });
  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId), null);

  updateAgentRuntimeManagedFieldsSync({ runtimeId, provisioningState: "managed", status: "online" });
  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId)?.id, queued.id);
});

test.after(() => {
  process.chdir(originalCwd);
});

function createRuntimeAndBinding(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  bindEmployeeRuntimeSync({ employeeName: "Atlas", runtimeId });
  return runtimeId;
}
