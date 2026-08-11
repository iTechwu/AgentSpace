import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCapabilityRequestSync,
  createWorkspaceSync,
  createUserSync,
  decideCapabilityRequestSync,
  getDatabase,
  readCapabilityRequestSync,
} from "./index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-capability-requests-"));
const originalCwd = process.cwd();

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = originalCwd;
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM capability_request;
    DELETE FROM agent_runtime;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

function seed() {
  const user = createUserSync({ displayName: "Requester", primaryEmail: "req@example.com" });
  const workspace = createWorkspaceSync({ name: "ws", createdBy: user.id, slug: "ws" });
  const now = new Date().toISOString();
  // Minimal agent_runtime seed (FK target for capability_request.runtime_id).
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, created_at, updated_at)
     VALUES (?, ?, 'codex', 'runtime-online', ?, ?)`,
  ).run(`runtime-${workspace.id}`, workspace.id, now, now);
  return { userId: user.id, workspaceId: workspace.id, runtimeId: `runtime-${workspace.id}` };
}

test("createCapabilityRequestSync returns the same id when re-submitted with the same idempotency key", () => {
  const { userId, workspaceId, runtimeId } = seed();
  const base = {
    workspaceId,
    requestedByUserId: userId,
    runtimeId,
    packageKind: "cli" as const,
    packageSource: "clihub_harness",
    packageSlug: "mermaid",
    packageDisplayName: "Mermaid",
    deploymentMode: "runtime_package" as const,
    requestedAction: "install" as const,
  };

  const first = createCapabilityRequestSync(base);
  const second = createCapabilityRequestSync(base);

  assert.equal(second.id, first.id);
  assert.equal(second.status, "pending");
});

test("re-submitting a terminal request reopens it to pending and clears the decision", () => {
  const { userId, workspaceId, runtimeId } = seed();
  const base = {
    workspaceId,
    requestedByUserId: userId,
    runtimeId,
    packageKind: "cli" as const,
    packageSource: "clihub_harness",
    packageSlug: "mermaid",
    packageDisplayName: "Mermaid",
    deploymentMode: "runtime_package" as const,
    requestedAction: "install" as const,
  };

  const first = createCapabilityRequestSync(base);
  decideCapabilityRequestSync({
    requestId: first.id,
    workspaceId,
    decidedByUserId: userId,
    decision: "rejected",
    decisionReason: "Not now.",
  });
  const rejected = readCapabilityRequestSync(first.id, workspaceId);
  assert.equal(rejected?.status, "rejected");
  assert.equal(rejected?.decisionReason, "Not now.");

  const reopened = createCapabilityRequestSync(base);
  assert.equal(reopened.id, first.id);
  assert.equal(reopened.status, "pending");
  assert.equal(reopened.decisionReason, undefined);
  assert.equal(reopened.decidedByUserId, undefined);
  assert.equal(reopened.completedAt, undefined);
});
