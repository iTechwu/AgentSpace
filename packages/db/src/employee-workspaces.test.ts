import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  commitWorkspaceRevisionSync,
  createWorkspaceRevisionSync,
  ensureEmployeePersistentWorkspaceSync,
  listEmployeeArtifactsSync,
  listWorkspaceRevisionsSync,
  publishEmployeeArtifactSync,
  readEmployeePersistentWorkspaceSync,
  readHeadRevisionSync,
  restoreWorkspaceRevisionSync,
  softDeleteEmployeeArtifactSync,
  getDatabase,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-ews-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

const MANIFEST_JSON = (seed: string): string => JSON.stringify({ taskId: `task-${seed}`, files: [{ path: "a.txt", sha256: seed, size: 1, mediaType: "text/plain" }] });

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
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM task_commit_journal");
});

after(() => {
  process.chdir(originalCwd);
});

test("ensure creates a persistent workspace once and is idempotent", () => {
  const first = ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const second = ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  assert.equal(first.id, second.id);
  assert.equal(first.employeeName, "Alice");
  assert.equal(first.storageHealth, "unknown");
});

test("revision commits atomically and advances the head", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const revision = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "a".repeat(64),
    manifestJson: MANIFEST_JSON("1"),
    status: "pending",
  });
  assert.equal(revision.status, "pending");

  const committed = commitWorkspaceRevisionSync(revision.id, "default");
  assert.equal(committed.status, "committed");

  const head = readHeadRevisionSync("Alice", "default");
  assert.equal(head?.id, committed.id);
  const ws = readEmployeePersistentWorkspaceSync("Alice", "default");
  assert.equal(ws?.headRevisionId, committed.id);
  assert.equal(ws?.storageHealth, "healthy");
});

test("D-05: identical digest re-creates the same revision (no duplicate publish)", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const first = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "b".repeat(64),
    manifestJson: MANIFEST_JSON("2"),
  });
  const second = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "b".repeat(64),
    manifestJson: MANIFEST_JSON("2"),
  });
  assert.equal(second.id, first.id);
  assert.equal(listWorkspaceRevisionsSync({ employeeName: "Alice", workspaceId: "default" }).length, 1);
});

test("commit conflict: stale parent against head throws REVISION_CONFLICT", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const first = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "c".repeat(64),
    manifestJson: MANIFEST_JSON("3"),
  });
  commitWorkspaceRevisionSync(first.id, "default"); // head = first

  const second = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    parentRevisionId: first.id,
    manifestDigest: "d".repeat(64),
    manifestJson: MANIFEST_JSON("4"),
  });
  commitWorkspaceRevisionSync(second.id, "default"); // head = second

  // A concurrent writer based on the stale head (first) must be rejected.
  const stale = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    parentRevisionId: first.id,
    manifestDigest: "e".repeat(64),
    manifestJson: MANIFEST_JSON("5"),
  });
  assert.throws(() => {
    commitWorkspaceRevisionSync(stale.id, "default");
  }, /REVISION_CONFLICT/);
});

test("restore produces a NEW head revision, never overwriting history", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Bob" });
  const v1 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    manifestDigest: "f".repeat(64),
    manifestJson: MANIFEST_JSON("6"),
  });
  commitWorkspaceRevisionSync(v1.id, "default");
  const v2 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    parentRevisionId: v1.id,
    manifestDigest: "g".repeat(64),
    manifestJson: MANIFEST_JSON("7"),
  });
  commitWorkspaceRevisionSync(v2.id, "default");

  const restored = restoreWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    targetRevisionId: v1.id,
    manifestDigest: "f".repeat(64),
    manifestJson: MANIFEST_JSON("6"),
  });
  assert.equal(restored.status, "committed");
  assert.notEqual(restored.id, v1.id, "restore must not mutate the original revision");
  assert.equal(readHeadRevisionSync("Bob", "default")?.id, restored.id);
});

test("published artifacts are listed and soft-deleted", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Carol" });
  const artifact = publishEmployeeArtifactSync({
    workspaceId: "default",
    employeeName: "Carol",
    contentDigest: "h".repeat(64),
    mediaType: "application/pdf",
    fileName: "report.pdf",
    sizeBytes: 1024,
  });
  assert.ok(artifact.id.startsWith("eart-"));

  assert.equal(listEmployeeArtifactsSync({ employeeName: "Carol", workspaceId: "default" }).length, 1);
  assert.equal(softDeleteEmployeeArtifactSync(artifact.id, "default"), true);
  assert.equal(listEmployeeArtifactsSync({ employeeName: "Carol", workspaceId: "default" }).length, 0);
});
