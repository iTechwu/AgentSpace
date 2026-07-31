import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import {
  createEmployeeSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
  readSkillDependencyInstallStatusSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-dep-install-status-"));
const TEST_USER_ID = "user-1";
const WORKSPACE_ID = "dep-install-status-test";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync(WORKSPACE_ID);
  const db = getDatabase();
  db.exec("DELETE FROM users");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
     VALUES (?, 'Test User', 'test@example.com', 1, ?, ?)`,
  ).run(TEST_USER_ID, now, now);
});

after(() => {
  process.chdir(originalCwd);
});

test("readSkillDependencyInstallStatusSync reports none for non-GitHub skills", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "local-skill",
    description: "Local",
    sourceType: "clihub_runtime_app",
    configJson: JSON.stringify({ dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }] }),
  }, WORKSPACE_ID);
  assert.equal(
    readSkillDependencyInstallStatusSync({ workspaceId: WORKSPACE_ID, employeeName: "Researcher", skillId: skill.id }),
    "none",
  );
});

test("readSkillDependencyInstallStatusSync reports none for GitHub skills without dependencies", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "gh-skill",
    description: "GitHub",
    sourceType: "github",
    configJson: JSON.stringify({ requirements: [{ kind: "config", value: "API_ENDPOINT" }] }),
  }, WORKSPACE_ID);
  assert.equal(
    readSkillDependencyInstallStatusSync({ workspaceId: WORKSPACE_ID, employeeName: "Researcher", skillId: skill.id }),
    "none",
  );
});

test("readSkillDependencyInstallStatusSync reports waiting_runtime when a GitHub skill has deps but no bound runtime", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "gh-with-deps",
    description: "GitHub deps",
    sourceType: "github",
    configJson: JSON.stringify({ dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }] }),
  }, WORKSPACE_ID);
  assert.equal(
    readSkillDependencyInstallStatusSync({ workspaceId: WORKSPACE_ID, employeeName: "Researcher", skillId: skill.id }),
    "waiting_runtime",
  );
});
