import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindApprovedCapabilityRequestToMcpConnectionSync,
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
  assert.equal(first.outcome, "created");
  const second = createCapabilityRequestSync(base);
  assert.equal(second.outcome, "in_flight");

  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.status, "pending");
});

test("re-submitting an in-flight request is a CAS no-op that preserves server-side state", () => {
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
  // Simulate the dispatch flow pinning a release + enriching metadata after
  // the request was created/approved.
  decideCapabilityRequestSync({
    requestId: first.record.id,
    workspaceId,
    decidedByUserId: userId,
    decision: "approved",
    decisionReason: "Ship it.",
  });
  // Capture updatedAt AFTER the decision — approval stamps updated_at, and the
  // CAS no-op's contract is "re-submitting does not touch the CURRENT record",
  // not "does not touch the original create timestamp".
  const approvedRecord = readCapabilityRequestSync(first.record.id, workspaceId);
  const firstUpdatedAt = approvedRecord?.updatedAt;

  // Re-submit with a DIFFERENT display name, message, and metadata. A true CAS
  // must NOT clobber the approved request — outcome is in_flight and nothing
  // the requester re-declared overwrites the server-side decision/metadata.
  const resubmitted = createCapabilityRequestSync({
    ...base,
    packageDisplayName: "Mermaid (renamed by re-submitter)",
    message: "hijack",
    metadataJson: JSON.stringify({ hijacked: true }),
  });
  assert.equal(resubmitted.outcome, "in_flight");
  assert.equal(resubmitted.record.id, first.record.id);
  assert.equal(resubmitted.record.status, "approved");
  assert.equal(resubmitted.record.packageDisplayName, "Mermaid");
  assert.equal(resubmitted.record.message, "");
  assert.equal(resubmitted.record.decisionReason, "Ship it.");
  // metadataJson is a JSONB string on the record — the CAS no-op must preserve
  // the original `'{}'`, not the re-submitter's `{"hijacked":true}`.
  assert.equal(resubmitted.record.metadataJson, "{}");
  assert.equal(resubmitted.record.updatedAt, firstUpdatedAt);
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
    requestId: first.record.id,
    workspaceId,
    decidedByUserId: userId,
    decision: "rejected",
    decisionReason: "Not now.",
  });
  const rejected = readCapabilityRequestSync(first.record.id, workspaceId);
  assert.equal(rejected?.status, "rejected");
  assert.equal(rejected?.decisionReason, "Not now.");

  const reopened = createCapabilityRequestSync(base);
  assert.equal(reopened.outcome, "reopened");
  assert.equal(reopened.record.id, first.record.id);
  assert.equal(reopened.record.status, "pending");
  assert.equal(reopened.record.decisionReason, undefined);
  assert.equal(reopened.record.decidedByUserId, undefined);
  assert.equal(reopened.record.completedAt, undefined);
});

test("MCP connection binding ignores approved requests without a catalog pin", () => {
  const { userId, workspaceId, runtimeId } = seed();
  const request = createCapabilityRequestSync({
    workspaceId,
    requestedByUserId: userId,
    runtimeId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: "legacy-mcp",
    packageDisplayName: "Legacy MCP",
    deploymentMode: "external_service",
    requestedAction: "connect",
    metadataJson: "{}",
  }).record;
  decideCapabilityRequestSync({
    requestId: request.id,
    workspaceId,
    decidedByUserId: userId,
    decision: "approved",
  });

  const bound = bindApprovedCapabilityRequestToMcpConnectionSync({
    workspaceId,
    runtimeId,
    packageSource: "official",
    packageSlug: "legacy-mcp",
    catalogItemId: "catalog-new-release",
    connectionId: "connection-not-created",
  });
  assert.equal(bound, null);
  assert.equal(readCapabilityRequestSync(request.id, workspaceId)?.linkedMcpConnectionId, undefined);
});
