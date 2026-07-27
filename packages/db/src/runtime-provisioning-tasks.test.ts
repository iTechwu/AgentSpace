import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  advanceRuntimeProvisioningTaskStageSync,
  appendRuntimeProvisioningEventSync,
  claimManagedProvisioningStageSync,
  completeManagedRuntimeCleanupRequestSync,
  completeRuntimeProvisioningCancellationSync,
  createRuntimeProvisioningTaskSync,
  listAuditLogsSync,
  listPendingManagedRuntimeCleanupRequestsForDaemonSync,
  listRuntimeProvisioningTaskEventsSync,
  listRuntimeProvisioningTasksSync,
  markRuntimeProvisioningTaskCancellingSync,
  markManagedRuntimeCleanupRequestRunningSync,
  markRuntimeProvisioningTaskFailedSync,
  markRuntimeProvisioningTaskReadySync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskByIdempotencyKeySync,
  readRuntimeProvisioningTaskSync,
  readWorkspaceSsoBindingSync,
  recordAuditLogSync,
  registerDaemonRuntimesSync,
  requestManagedRuntimeCleanupSync,
  failManagedRuntimeCleanupRequestSync,
  resetRuntimeProvisioningTaskForRetrySync,
  updateAgentRuntimeManagedFieldsSync,
  upsertWorkspaceSsoBindingSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-provisioning-"));
const WORKSPACE = "provisioning-ws";
const USER = "provisioning-test-user";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_provisioning_task_event");
  db.exec("DELETE FROM runtime_provisioning_task");
  db.exec("DELETE FROM managed_runtime_cleanup_request");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM workspace_sso_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  ensureWorkspace();
});

after(() => process.chdir(originalCwd));

test("workspace SSO binding upserts team and tenant scopes", () => {
  upsertWorkspaceSsoBindingSync({
    workspaceId: WORKSPACE,
    tenantId: "tenant-1",
    tenantName: "Acme",
    teamId: "team-1",
    teamName: "Engineering",
    source: "team",
  });
  const teamBinding = readWorkspaceSsoBindingSync(WORKSPACE);
  assert.equal(teamBinding?.teamId, "team-1");
  assert.equal(teamBinding?.source, "team");

  // Re-upsert as tenant-only scope; teamId clears.
  upsertWorkspaceSsoBindingSync({
    workspaceId: WORKSPACE,
    tenantId: "tenant-1",
    tenantName: "Acme",
    source: "tenant",
  });
  const tenantBinding = readWorkspaceSsoBindingSync(WORKSPACE);
  assert.equal(tenantBinding?.teamId, undefined);
  assert.equal(tenantBinding?.source, "tenant");
});

test("provisioning task create is idempotent by workspace + idempotency key", () => {
  const first = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "runtime-A:create:v1",
    runtimeType: "claude",
    protocols: ["anthropic"],
    requestedModel: "claude-sonnet",
  });
  const second = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "runtime-A:create:v1",
    runtimeType: "claude",
    protocols: ["anthropic"],
  });
  assert.equal(second.id, first.id);
  assert.equal(readRuntimeProvisioningTaskByIdempotencyKeySync(WORKSPACE, "runtime-A:create:v1")?.id, first.id);
  assert.equal(listRuntimeProvisioningTasksSync(WORKSPACE).length, 1);
});

test("advance stage records credential ref and marks task running", () => {
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "k1",
    runtimeType: "codex",
    protocols: ["openai"],
  });
  const advanced = advanceRuntimeProvisioningTaskStageSync({
    id: task.id,
    workspaceId: WORKSPACE,
    stage: "request_credential",
    status: "succeeded",
    progressPercent: 20,
    runtimeCredentialId: "rtc-1",
    secretRef: "vault://runtimes/rtc-1",
  });
  assert.equal(advanced?.status, "running");
  assert.equal(advanced?.stage, "request_credential");
  assert.equal(advanced?.runtimeCredentialId, "rtc-1");
  assert.equal(advanced?.secretRef, "vault://runtimes/rtc-1");
  assert.equal(advanced?.progressPercent, 20);
  const events = listRuntimeProvisioningTaskEventsSync(task.id);
  assert.ok(events.some((event) => event.stage === "request_credential" && event.status === "succeeded"));
});

test("mark failed locates the stage, retry resets and bumps retry count", () => {
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "k2",
    runtimeType: "claude",
    protocols: ["anthropic"],
  });
  const failed = markRuntimeProvisioningTaskFailedSync({
    id: task.id,
    workspaceId: WORKSPACE,
    stage: "prepare_node",
    errorCode: "node_offline",
    errorMessage: "target server did not register",
  });
  assert.equal(failed?.status, "retrying");
  assert.equal(failed?.stage, "prepare_node");
  assert.equal(failed?.lastErrorCode, "node_offline");
  assert.equal(failed?.lastErrorMessage, "target server did not register");

  const retried = resetRuntimeProvisioningTaskForRetrySync({ id: task.id, workspaceId: WORKSPACE });
  assert.equal(retried?.status, "queued");
  assert.equal(retried?.stage, "pending");
  assert.equal(retried?.retryCount, 1);
});

test("cancel flow marks cancelling then completes cancellation", () => {
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "k3",
    runtimeType: "gemini",
    protocols: ["gemini"],
  });
  advanceRuntimeProvisioningTaskStageSync({
    id: task.id,
    workspaceId: WORKSPACE,
    stage: "request_credential",
    status: "succeeded",
    progressPercent: 20,
    runtimeCredentialId: "rtc-3",
  });
  const cancelling = markRuntimeProvisioningTaskCancellingSync({ id: task.id, workspaceId: WORKSPACE });
  assert.equal(cancelling?.status, "cancelling");
  assert.equal(cancelling?.cleanupStatus, "running");

  const done = completeRuntimeProvisioningCancellationSync({
    id: task.id,
    workspaceId: WORKSPACE,
    cleanupStatus: "succeeded",
    cleanupResult: { revokedCredentialId: "rtc-3" },
  });
  assert.equal(done?.status, "cancelled");
  assert.equal(done?.cleanupStatus, "succeeded");
  assert.ok(done?.cleanupResultJson?.includes("rtc-3"));
});

test("mark ready sets 100% progress and succeeded status", () => {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: "managed-daemon",
    deviceName: "Runner",
    workspaceId: WORKSPACE,
    runtimes: [{ provider: "claude", name: "Managed Claude" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "k4",
    runtimeType: "claude",
    protocols: ["anthropic"],
  });
  const ready = markRuntimeProvisioningTaskReadySync({ id: task.id, workspaceId: WORKSPACE, runtimeId });
  assert.equal(ready?.status, "succeeded");
  assert.equal(ready?.stage, "ready");
  assert.equal(ready?.progressPercent, 100);
  assert.equal(ready?.runtimeId, runtimeId);
});

test("agent_runtime managed fields round-trip through read", () => {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: "managed-daemon-2",
    deviceName: "Runner",
    workspaceId: WORKSPACE,
    runtimes: [{ provider: "codex", name: "Managed Codex" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  updateAgentRuntimeManagedFieldsSync({
    runtimeId,
    workspaceId: WORKSPACE,
    provisioningState: "managed",
    managedCredentialId: "rtc-9",
    credentialSecretRef: "vault://runtimes/rtc-9",
    protocols: ["openai"],
    defaultModel: "gpt-5",
  });
  const runtime = readAgentRuntimeSync(runtimeId);
  assert.equal(runtime?.provisioningState, "managed");
  assert.equal(runtime?.managedCredentialId, "rtc-9");
  assert.equal(runtime?.credentialSecretRef, "vault://runtimes/rtc-9");
  assert.deepEqual(runtime?.protocols, ["openai"]);
  assert.equal(runtime?.defaultModel, "gpt-5");
  assert.ok(runtime?.managedAt);
});

test("audit log records and lists immutable rows", () => {
  recordAuditLogSync({
    workspaceId: WORKSPACE,
    title: "Runtime credential created",
    note: "Issued rtc-1 for runtime-A",
    code: "runtime_credential.created",
    source: "runtime_credential",
    data: { keyFingerprint: "sha256:abc", runtimeId: "runtime-A" },
  });
  const rows = listAuditLogsSync(WORKSPACE, { code: "runtime_credential.created" });
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.dataJson.includes("sha256:abc"));
  assert.equal(rows[0]!.source, "runtime_credential");
  // Plaintext keys must never appear.
  assert.ok(!JSON.stringify(rows).toLowerCase().includes("sk-"));
});

test("audit log supports runtime, actor, employee, session, task, model, and time filters", () => {
  recordAuditLogSync({
    workspaceId: WORKSPACE,
    title: "Execution completed",
    note: "done",
    code: "execution.completed",
    data: { actorId: "owner-1", employeeId: "atlas", runtimeId: "runtime-1", sessionId: "session-1", taskId: "task-1", modelId: "gpt-5" },
  });
  recordAuditLogSync({ workspaceId: WORKSPACE, title: "Other", note: "other", code: "execution.failed", data: { runtimeId: "runtime-2" } });

  const filters = { actorId: "owner-1", employeeId: "atlas", runtimeId: "runtime-1", sessionId: "session-1", taskId: "task-1", modelId: "gpt-5", createdFrom: "2020-01-01T00:00:00.000Z", createdTo: "2030-01-01T00:00:00.000Z" };
  assert.deepEqual(listAuditLogsSync(WORKSPACE, filters).map((row) => row.code), ["execution.completed"]);
});

test("appendRuntimeProvisioningEventSync writes an extra readable event", () => {
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "k5",
    runtimeType: "claude",
    protocols: ["anthropic"],
  });
  appendRuntimeProvisioningEventSync({
    taskId: task.id,
    stage: "write_credential",
    status: "running",
    progressPercent: 60,
    title: "Applying gateway config",
    severity: "info",
  });
  const events = listRuntimeProvisioningTaskEventsSync(task.id);
  assert.ok(events.some((event) => event.title === "Applying gateway config" && event.progressPercent === 60));
});

test("managed nodes claim provisioning tasks within their authenticated workspace", () => {
  const regularNode = registerDaemonRuntimesSync({
    daemonKey: "regular-node-claim",
    deviceName: "regular-node-claim",
    workspaceId: WORKSPACE,
    runtimes: [{ provider: "codex", name: "Local Codex" }],
  });
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: "managed-node-claim",
    deviceName: "managed-node-claim",
    workspaceId: WORKSPACE,
    metadata: { managedNode: true },
    runtimes: [],
  });
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: WORKSPACE,
    requestedByUserId: USER,
    idempotencyKey: "claim-task",
    runtimeType: "codex",
    protocols: ["openai"],
  });
  advanceRuntimeProvisioningTaskStageSync({
    id: task.id,
    workspaceId: WORKSPACE,
    stage: "pull_image",
    status: "pending",
    progressPercent: 50,
  });

  assert.equal(claimManagedProvisioningStageSync({
    daemonConnectionId: regularNode.daemon.id,
    workspaceId: WORKSPACE,
  }), null);

  const claimed = claimManagedProvisioningStageSync({
    daemonConnectionId: snapshot.daemon.id,
    workspaceId: WORKSPACE,
  });

  assert.equal(claimed?.id, task.id);
  assert.equal(claimed?.daemonConnectionId, snapshot.daemon.id);
  assert.equal(claimed?.stageStatus, "running");
});

test("managed cleanup retries are not claimable before their backoff expires", () => {
  const snapshot = registerDaemonRuntimesSync({ daemonKey: "cleanup-node", deviceName: "cleanup-node", workspaceId: WORKSPACE, runtimes: [{ provider: "codex", name: "Cleanup Codex" }] });
  const request = requestManagedRuntimeCleanupSync({ workspaceId: WORKSPACE, runtimeId: snapshot.runtimes[0]!.id, daemonConnectionId: snapshot.daemon.id, runtimeType: "codex" });
  assert.equal(request.attemptCount, 0);
  assert.equal(listPendingManagedRuntimeCleanupRequestsForDaemonSync(snapshot.daemon.id).length, 1);
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(request.id)?.status, "running");
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(request.id), null);
  const retrying = failManagedRuntimeCleanupRequestSync(request.id, "cleanup.failed", "temporary failure");
  assert.equal(retrying?.status, "pending");
  assert.equal(retrying?.attemptCount, 1);
  assert.ok(retrying?.nextAttemptAt);
  assert.equal(listPendingManagedRuntimeCleanupRequestsForDaemonSync(snapshot.daemon.id).length, 0);

  const duplicateFailure = failManagedRuntimeCleanupRequestSync(request.id, "cleanup.duplicate", "duplicate callback");
  assert.equal(duplicateFailure?.attemptCount, 1);
  assert.equal(duplicateFailure?.lastErrorCode, "cleanup.failed");

  const lateSuccess = completeManagedRuntimeCleanupRequestSync(request.id, "succeeded", { removed: true });
  assert.equal(lateSuccess?.status, "pending");
  assert.equal(lateSuccess?.resultJson, undefined);
});

test("managed cleanup fails after its configured maximum number of attempts", () => {
  const snapshot = registerDaemonRuntimesSync({ daemonKey: "cleanup-limit-node", deviceName: "cleanup-limit-node", workspaceId: WORKSPACE, runtimes: [{ provider: "codex", name: "Cleanup Codex" }] });
  const request = requestManagedRuntimeCleanupSync({ workspaceId: WORKSPACE, runtimeId: snapshot.runtimes[0]!.id, daemonConnectionId: snapshot.daemon.id, runtimeType: "codex" });
  const db = getDatabase();

  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    db.prepare("UPDATE managed_runtime_cleanup_request SET status = 'pending', next_attempt_at = NULL WHERE id = ?").run(request.id);
    assert.equal(markManagedRuntimeCleanupRequestRunningSync(request.id)?.status, "running");
    const failed = failManagedRuntimeCleanupRequestSync(request.id, "cleanup.failed", `failure ${attempt}`);
    assert.equal(failed?.attemptCount, attempt);
    assert.equal(failed?.status, attempt === request.maxAttempts ? "failed" : "pending");
  }
});

test("managed cleanup completion is idempotent after a successful claim", () => {
  const snapshot = registerDaemonRuntimesSync({ daemonKey: "cleanup-success-node", deviceName: "cleanup-success-node", workspaceId: WORKSPACE, runtimes: [{ provider: "codex", name: "Cleanup Codex" }] });
  const request = requestManagedRuntimeCleanupSync({ workspaceId: WORKSPACE, runtimeId: snapshot.runtimes[0]!.id, daemonConnectionId: snapshot.daemon.id, runtimeType: "codex" });
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(request.id)?.status, "running");

  const completed = completeManagedRuntimeCleanupRequestSync(request.id, "succeeded", { removed: true });
  assert.equal(completed?.status, "succeeded");
  assert.deepEqual(JSON.parse(completed?.resultJson ?? "{}"), { removed: true });

  const duplicate = completeManagedRuntimeCleanupRequestSync(request.id, "succeeded", { removed: false });
  assert.equal(duplicate?.status, "succeeded");
  assert.deepEqual(JSON.parse(duplicate?.resultJson ?? "{}"), { removed: true });
});

function ensureWorkspace(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Test user', ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(USER, now, now);
  db.prepare(
    "INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(WORKSPACE, WORKSPACE, WORKSPACE, USER, now, now);
}
