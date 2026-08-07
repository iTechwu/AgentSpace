import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  listCommitJournalsForWorkspaceSync,
  listStaleCommitJournalsSync,
  readTaskCommitJournalSync,
  upsertTaskCommitJournalSync,
  getDatabase,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-commit-journal-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

let taskSeq = 0;

function insertTestTask(workspaceId = "default"): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-test-${taskSeq}`;
  const taskId = `task-test-${taskSeq}`;
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, ?, 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, workspaceId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, ?, 'agent-test', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, workspaceId, runtimeId, now, now, now);
  return taskId;
}

before(() => {
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
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_runtime");
});

after(() => {
  process.chdir(originalCwd);
});

test("journal state updates do not consume reconciliation attempts", () => {
  const taskId = insertTestTask();
  const first = upsertTaskCommitJournalSync({ taskId, workspaceId: "default", commitState: "preparing" });
  assert.equal(first.commitState, "preparing");
  assert.equal(first.attempt, 0);

  const second = upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    commitState: "committed",
    workspaceRevisionId: "ewr-1",
    artifactIdsJson: '["eart-1"]',
  });
  assert.equal(second.commitState, "committed");
  assert.equal(second.attempt, 0, "checkpoint state changes do not consume retry budget");
  assert.equal(second.workspaceRevisionId, "ewr-1");
  assert.equal(second.artifactIdsJson, '["eart-1"]');

  const retried = upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    commitState: "preparing",
    incrementAttempt: true,
  });
  assert.equal(retried.attempt, 1, "only an actual reconciliation failure increments attempt");
  assert.equal(retried.workspaceRevisionId, "ewr-1", "state-only updates preserve the promoted revision");
  assert.equal(retried.artifactIdsJson, '["eart-1"]', "state-only updates preserve promoted artifacts");

  // Only one row per task.
  assert.equal(listCommitJournalsForWorkspaceSync("default").filter((j) => j.taskId === taskId).length, 1);
});

test("read returns the latest journal state", () => {
  const taskId = insertTestTask();
  upsertTaskCommitJournalSync({ taskId, workspaceId: "default", commitState: "committed" });
  const journal = readTaskCommitJournalSync(taskId, "default");
  assert.ok(journal);
  assert.equal(journal.commitState, "committed");
});

test("stale preparing_commit journals surface for reconciliation", () => {
  const db = getDatabase();
  const old = insertTestTask();
  const fresh = insertTestTask();
  upsertTaskCommitJournalSync({ taskId: old, workspaceId: "default", commitState: "preparing" });
  upsertTaskCommitJournalSync({ taskId: fresh, workspaceId: "default", commitState: "preparing" });

  // Age the `old` journal by backdating its updated_at beyond the threshold.
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(`UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?`).run(staleCutoff, old);

  const stale = listStaleCommitJournalsSync({ workspaceId: "default", staleBeforeSeconds: 300 });
  assert.ok(stale.some((journal) => journal.taskId === old), "old journal should be flagged stale");
  assert.ok(!stale.some((journal) => journal.taskId === fresh), "fresh journal must not be flagged");
});

test("global stale journal scan includes non-default workspaces while an explicit filter stays scoped", () => {
  const db = getDatabase();
  const defaultTask = insertTestTask("default");
  const alternateTask = insertTestTask("workspace-alternate");
  upsertTaskCommitJournalSync({ taskId: defaultTask, workspaceId: "default", commitState: "preparing" });
  upsertTaskCommitJournalSync({ taskId: alternateTask, workspaceId: "workspace-alternate", commitState: "preparing" });
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id IN (?, ?)")
    .run(staleAt, defaultTask, alternateTask);

  const global = listStaleCommitJournalsSync({ staleBeforeSeconds: 300 });
  assert.deepEqual(new Set(global.map((journal) => journal.taskId)), new Set([defaultTask, alternateTask]));
  const alternateOnly = listStaleCommitJournalsSync({
    workspaceId: "workspace-alternate",
    staleBeforeSeconds: 300,
  });
  assert.deepEqual(alternateOnly.map((journal) => journal.taskId), [alternateTask]);
});

test("stale committed tasks surface until completion finalization runs", () => {
  const db = getDatabase();
  const taskId = insertTestTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    commitState: "committed",
    workspaceRevisionId: "ewr-crash-gap",
    artifactIdsJson: '["eart-crash-gap"]',
  });
  db.prepare("UPDATE agent_task_queue SET status = 'committed' WHERE id = ?").run(taskId);
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?").run(staleAt, taskId);

  assert.deepEqual(
    listStaleCommitJournalsSync({ workspaceId: "default", staleBeforeSeconds: 300 }).map((item) => item.taskId),
    [taskId],
  );

  db.prepare("UPDATE agent_task_queue SET status = 'completed' WHERE id = ?").run(taskId);
  assert.equal(
    listStaleCommitJournalsSync({ workspaceId: "default", staleBeforeSeconds: 300 }).some((item) => item.taskId === taskId),
    false,
    "a fully completed task with a committed journal is not repeatedly reconciled",
  );
});

test("rolled_back state is preserved", () => {
  const taskId = insertTestTask();
  upsertTaskCommitJournalSync({ taskId, workspaceId: "default", commitState: "rolled_back", errorMessage: "orphan reclaimed" });
  const journal = readTaskCommitJournalSync(taskId, "default");
  assert.equal(journal.commitState, "rolled_back");
  assert.equal(journal.errorMessage, "orphan reclaimed");
});
