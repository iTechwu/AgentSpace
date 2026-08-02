import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  readContentBlobSync,
  readHeadRevisionSync,
  upsertContentBlobSync,
} from "@dofe-agent/db";
import {
  promoteArtifactSync,
  promoteTaskOutputsToWorkspaceSync,
  reclaimOrphanContentBlobsSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import { sha256Hex } from "../../src/attachments/storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-pws-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();
let taskSeq = 0;

/** Inserts a real agent_task_queue row (revision.source_task_id is a hard FK). */
function insertTestTask(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-pws-${taskSeq}`;
  const taskId = `task-pws-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-pws', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  return taskId;
}

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testStorage.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

/** The shared test PG occasionally loses the default workspace row; re-seed it. */
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
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM content_blob");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_runtime");
});

after(() => {
  process.chdir(originalCwd);
});

test("D-03b: consecutive outputs produce a full snapshot; recovery restores every file", () => {
  const task1 = insertTestTask();
  const task2 = insertTestTask();

  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: task1,
    employeeName: "Alice",
    outputs: [{ path: "first.txt", bytes: new TextEncoder().encode("first") }],
  });

  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: task2,
    employeeName: "Alice",
    outputs: [{ path: "second.txt", bytes: new TextEncoder().encode("second") }],
  });

  const head = readHeadRevisionSync("Alice", "default");
  assert.ok(head);
  const manifest = JSON.parse(head.manifestJson) as { files: Array<{ path: string; sha256: string }> };
  const paths = manifest.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ["first.txt", "second.txt"]);
});

test("D-03: task outputs promoted to a committed workspace revision readable after workDir cleanup", () => {
  const outputs = [
    { path: "report.pdf", bytes: new TextEncoder().encode("%PDF-1.4 fake report") },
    { path: "images/chart.png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
  ];

  const result = promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Alice",
    outputs,
  });

  assert.equal(result.created, true);
  assert.equal(result.revision.status, "committed");
  assert.equal(result.revision.manifestDigest.length, 64);
  assert.equal(readHeadRevisionSync("Alice", "default")?.id, result.revision.id);

  // Blob indexed and readable (survives workDir deletion because it lives in object storage).
  for (const output of outputs) {
    const blob = readContentBlobSync(sha256Hex(output.bytes), "default");
    assert.ok(blob, `blob missing for ${output.path}`);
    assert.equal(blob.sha256, sha256Hex(output.bytes));
  }
});

test("D-05: re-promoting the same task+outputs is idempotent (no duplicate revision)", () => {
  const outputs = [{ path: "a.txt", bytes: new TextEncoder().encode("hello") }];
  const taskId = insertTestTask();
  const first = promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId,
    employeeName: "Alice",
    outputs,
  });
  const second = promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId,
    employeeName: "Alice",
    outputs,
  });

  assert.equal(second.created, false);
  assert.equal(second.revision.id, first.revision.id);
  assert.equal(readHeadRevisionSync("Alice", "default")?.id, first.revision.id);
});

test("publishArtifacts promotes each output as an employee_artifact", () => {
  const result = promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Bob",
    outputs: [{ path: "deck.pptx", bytes: new TextEncoder().encode("fake pptx") }],
    publishArtifacts: true,
  });
  assert.equal(result.artifactIds.length, 1);
});

test("promoteArtifactSync publishes a single formal artifact with a content digest", () => {
  const bytes = new TextEncoder().encode("formal report");
  const result = promoteArtifactSync({
    workspaceId: "default",
    employeeName: "Carol",
    fileName: "report.pdf",
    bytes,
    mediaType: "application/pdf",
  });
  assert.equal(result.digest, sha256Hex(bytes));
  assert.equal(result.artifact.fileName, "report.pdf");
});

test("D-04: orphan blob scan reclaims unreferenced blobs but keeps referenced ones", () => {
  // Referenced blob (part of a promoted revision).
  const referencedBytes = new TextEncoder().encode("keep-me");
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Alice",
    outputs: [{ path: "keep.txt", bytes: referencedBytes }],
  });

  // Orphan blob (uploaded directly, never referenced by a revision/artifact).
  const orphanBytes = new TextEncoder().encode("orphan-me");
  const orphanSha = sha256Hex(orphanBytes);
  testStorage.client.putContentAddressedBlobSync({
    workspaceId: "default",
    sha256: orphanSha,
    contentBytes: orphanBytes,
  });
  upsertContentBlobSync({
    workspaceId: "default",
    sha256: orphanSha,
    storageProvider: "tos",
    storageKey: `workspaces/default/content-blobs/${orphanSha.slice(0, 2)}/${orphanSha}`,
    sizeBytes: orphanBytes.byteLength,
  });

  const scan = reclaimOrphanContentBlobsSync({
    workspaceId: "default",
    retainRecentSeconds: 0,
    delete: true,
  });

  assert.ok(scan.orphans.some((o) => o.sha256 === orphanSha), "orphan blob must be detected");
  assert.ok(!scan.orphans.some((o) => o.sha256 === sha256Hex(referencedBytes)), "referenced blob must be kept");
  assert.ok(scan.reclaimedCount >= 1);
  assert.equal(readContentBlobSync(orphanSha, "default"), null, "orphan index row deleted");
  assert.ok(readContentBlobSync(sha256Hex(referencedBytes), "default"), "referenced blob index kept");
});
