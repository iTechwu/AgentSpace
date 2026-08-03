import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";
import {
  listSkillRunnerInvocationsSync,
  readSkillRunnerInvocationSync,
  recordSkillRunnerInvocationSync,
} from "./index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM skill_runner_invocation").run();
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(DEFAULT_WORKSPACE_ID, "default", "test", now, now);
  });
});

test("records a Skill Runner invocation with redacted fields", () => {
  const record = recordSkillRunnerInvocationSync({
    workspaceId: "default",
    taskId: "task-1",
    runtimeId: "rt-1",
    installationId: "install-1",
    skillId: "skill-1",
    skillName: "financial-analysis",
    artifactDigest: "abc".repeat(21) + "d",
    revision: "v1",
    entrypointId: "ep-1",
    entrypointKey: "skill-1:ep-1",
    entrypointPath: "scripts/run.sh",
    entrypointRuntime: "bash",
    actorId: "agent:planner",
    actorType: "agent",
    resultCode: 0,
    durationMs: 1200,
    safeSummary: "Skill entrypoint skill-1:ep-1 exited with code 0.",
    eventId: "event-1",
  });
  assert.ok(record.id.startsWith("sri-"));
  assert.equal(record.taskId, "task-1");
  assert.equal(record.skillName, "financial-analysis");
  assert.equal(record.entrypointKey, "skill-1:ep-1");
  assert.equal(record.actorId, "agent:planner");
  assert.equal(record.resultCode, 0);
  assert.equal(record.timedOut, false);
  assert.equal(record.durationMs, 1200);

  const reread = readSkillRunnerInvocationSync(record.id, "default");
  assert.ok(reread);
  assert.equal(reread.artifactDigest, record.artifactDigest);
});

test("is idempotent per (workspace, eventId) so daemon retries never duplicate", () => {
  const input = {
    workspaceId: "default",
    skillName: "render",
    artifactDigest: "a".repeat(64),
    entrypointId: "ep-1",
    entrypointKey: "skill-1:ep-1",
    actorId: "agent:planner",
    resultCode: 1,
    timedOut: true,
    eventId: "event-dedup",
  };
  const first = recordSkillRunnerInvocationSync(input);
  const second = recordSkillRunnerInvocationSync({ ...input, resultCode: 0 });
  assert.equal(second.id, first.id, "a resent event returns the first record");
  const all = listSkillRunnerInvocationsSync({ workspaceId: "default" });
  assert.equal(all.length, 1);
  assert.equal(all[0].resultCode, 1, "first write wins");
});

test("lists invocations by task and installation", () => {
  recordSkillRunnerInvocationSync({
    workspaceId: "default",
    taskId: "task-a",
    installationId: "install-x",
    skillName: "render",
    artifactDigest: "a".repeat(64),
    entrypointId: "ep-1",
    entrypointKey: "skill-1:ep-1",
    actorId: "agent:planner",
    resultCode: 0,
    eventId: "ev-1",
  });
  recordSkillRunnerInvocationSync({
    workspaceId: "default",
    taskId: "task-b",
    installationId: "install-y",
    skillName: "render",
    artifactDigest: "a".repeat(64),
    entrypointId: "ep-2",
    entrypointKey: "skill-1:ep-2",
    actorId: "agent:planner",
    resultCode: 2,
    eventId: "ev-2",
  });

  const byTask = listSkillRunnerInvocationsSync({ workspaceId: "default", taskId: "task-a" });
  assert.equal(byTask.length, 1);
  assert.equal(byTask[0].entrypointId, "ep-1");

  const byInstall = listSkillRunnerInvocationsSync({ workspaceId: "default", installationId: "install-y" });
  assert.equal(byInstall.length, 1);
  assert.equal(byInstall[0].resultCode, 2);
});

test("rejects missing actor or skill identity", () => {
  assert.throws(
    () =>
      recordSkillRunnerInvocationSync({
        workspaceId: "default",
        skillName: "",
        artifactDigest: "a".repeat(64),
        entrypointId: "ep-1",
        entrypointKey: "skill-1:ep-1",
        actorId: "agent:planner",
        resultCode: 0,
      }),
    /actorId, skillName and artifactDigest are required/,
  );
});
