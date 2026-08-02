import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  claimNextWorkspaceMountOperationForRuntimeSync,
  completeWorkspaceMountOperationSync,
  createWorkspaceMountOperationSync,
  failWorkspaceMountOperationSync,
  getDatabase,
  readWorkspaceMountOperationSync,
  renewWorkspaceMountOperationLeaseSync,
  requeueExpiredWorkspaceMountOperationLeasesSync,
  startWorkspaceMountOperationSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-mount-"));

before(() => {
  const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

function seedDefaultWorkspaceIfMissing(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
}

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_workspace_mount_operation");
  db.exec("DELETE FROM agent_runtime");
});

after(() => {
  process.chdir(originalCwd);
});

function insertRuntime(runtimeId: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'online', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
}

test("create → claim → complete drives a workspace mount operation to completed", () => {
  insertRuntime("runtime-1");
  const op = createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-1",
    employeeName: "Alice",
    headRevisionId: "ewr-1",
  });
  assert.equal(op.status, "pending");

  const claimed = claimNextWorkspaceMountOperationForRuntimeSync("runtime-1", "default");
  assert.ok(claimed);
  assert.equal(claimed!.id, op.id);
  assert.equal(claimed!.status, "claimed");

  startWorkspaceMountOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    claimGeneration: claimed!.claimGeneration,
  });
  const completed = completeWorkspaceMountOperationSync({
    operationId: op.id,
    workspaceId: "default",
    claimGeneration: claimed!.claimGeneration,
    materializedFiles: 3,
    mountedPath: "/state/runtime-workspaces/runtime-1/Alice",
  });
  assert.equal(completed.status, "completed");
  assert.ok(completed.completedAt);
  assert.equal(completed.materializedFiles, 3, "mount evidence: materialized file count stored");
  assert.equal(completed.mountedPath, "/state/runtime-workspaces/runtime-1/Alice", "mount evidence: persistent path stored");
});

test("claim is atomic and skips already-claimed operations", () => {
  insertRuntime("runtime-2");
  createWorkspaceMountOperationSync({ workspaceId: "default", runtimeId: "runtime-2", employeeName: "Bob" });
  createWorkspaceMountOperationSync({ workspaceId: "default", runtimeId: "runtime-2", employeeName: "Carol" });

  const first = claimNextWorkspaceMountOperationForRuntimeSync("runtime-2", "default");
  const second = claimNextWorkspaceMountOperationForRuntimeSync("runtime-2", "default");
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first!.id, second!.id, "two distinct ops claimed");
});

test("failed operations record the error and stay failed", () => {
  insertRuntime("runtime-3");
  const op = createWorkspaceMountOperationSync({ workspaceId: "default", runtimeId: "runtime-3", employeeName: "Dan" });
  // A worker must CLAIM the operation before it can fail it (status CAS).
  const claim = claimNextWorkspaceMountOperationForRuntimeSync("runtime-3", "default");
  assert.ok(claim);
  assert.equal(claim!.id, op.id);

  const failed = failWorkspaceMountOperationSync({
    operationId: op.id,
    workspaceId: "default",
    claimGeneration: claim!.claimGeneration,
    errorCode: "mount.materialization_failed",
    errorMessage: "blob missing",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "mount.materialization_failed");
  assert.equal(failed.errorMessage, "blob missing");

  // A failed op is not claimable again.
  const claimed = claimNextWorkspaceMountOperationForRuntimeSync("runtime-3", "default");
  assert.equal(claimed, null);
  assert.equal(readWorkspaceMountOperationSync(op.id, "default")?.status, "failed");
});

test("an unclaimed mount operation cannot be started", () => {
  insertRuntime("runtime-unclaimed");
  const op = createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-unclaimed",
    employeeName: "Erin",
  });

  assert.throws(
    () => startWorkspaceMountOperationSync({ operationId: op.id, workspaceId: "default", claimGeneration: 0 }),
    /not in a startable state/i,
  );
  assert.equal(readWorkspaceMountOperationSync(op.id, "default")?.status, "pending");
});

test("a claimed mount operation cannot complete before it starts", () => {
  insertRuntime("runtime-not-started");
  const op = createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-not-started",
    employeeName: "Frank",
  });
  claimNextWorkspaceMountOperationForRuntimeSync("runtime-not-started", "default");
  const claimed = readWorkspaceMountOperationSync(op.id, "default");
  assert.ok(claimed);

  assert.throws(
    () => completeWorkspaceMountOperationSync({
      operationId: op.id,
      workspaceId: "default",
      claimGeneration: claimed.claimGeneration,
      materializedFiles: 0,
      mountedPath: "/state/runtime-workspaces/runtime-not-started/Frank",
    }),
    /not in a completable state/i,
  );
});

test("starting a running mount operation is idempotent after a lost response", () => {
  insertRuntime("runtime-start-retry");
  createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-start-retry",
    employeeName: "Grace",
  });
  const claimed = claimNextWorkspaceMountOperationForRuntimeSync("runtime-start-retry", "default");
  assert.ok(claimed);

  const first = startWorkspaceMountOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
  });
  const retry = startWorkspaceMountOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
  });
  assert.equal(first.status, "running");
  assert.equal(retry.status, "running");
});

test("an expired mount lease is re-claimed with a new fencing generation", () => {
  insertRuntime("runtime-expired");
  createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-expired",
    employeeName: "Helen",
  });
  const first = claimNextWorkspaceMountOperationForRuntimeSync(
    "runtime-expired",
    "default",
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.ok(first);
  assert.equal(first.claimGeneration, 1);

  const second = claimNextWorkspaceMountOperationForRuntimeSync(
    "runtime-expired",
    "default",
    new Date("2026-01-01T00:03:00Z"),
  );
  assert.ok(second);
  assert.equal(second.id, first.id);
  assert.equal(second.claimGeneration, 2);

  assert.throws(
    () => startWorkspaceMountOperationSync({
      operationId: first.id,
      workspaceId: "default",
      claimGeneration: first.claimGeneration,
      now: new Date("2026-01-01T00:03:01Z"),
    }),
    /not in a startable state/i,
  );
});

test("mount lease renewal and requeue are fenced by generation", () => {
  insertRuntime("runtime-renew");
  createWorkspaceMountOperationSync({
    workspaceId: "default",
    runtimeId: "runtime-renew",
    employeeName: "Ian",
  });
  const claimed = claimNextWorkspaceMountOperationForRuntimeSync(
    "runtime-renew",
    "default",
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.ok(claimed);
  assert.equal(renewWorkspaceMountOperationLeaseSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    now: new Date("2026-01-01T00:01:00Z"),
  }), true);
  assert.equal(requeueExpiredWorkspaceMountOperationLeasesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:02:30Z"),
  }), 0);
  assert.equal(requeueExpiredWorkspaceMountOperationLeasesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:03:01Z"),
  }), 1);
  assert.equal(renewWorkspaceMountOperationLeaseSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    now: new Date("2026-01-01T00:03:02Z"),
  }), false);
});
