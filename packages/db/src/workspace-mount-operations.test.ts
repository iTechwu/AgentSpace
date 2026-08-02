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

  startWorkspaceMountOperationSync(claimed!.id, "default");
  const completed = completeWorkspaceMountOperationSync({
    operationId: op.id,
    workspaceId: "default",
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
