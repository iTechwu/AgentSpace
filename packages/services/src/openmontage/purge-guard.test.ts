import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import {
  createOpenMontageJobLinkSync,
  getDatabase,
} from "@dofe-agent/db";
import {
  assertOpenMontageMcpPurgeableAsync,
  assertOpenMontageRuntimePurgeableAsync,
  OpenMontagePurgeBlockedError,
} from "./purge-guard.ts";

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM openmontage_job_projection;
    DELETE FROM openmontage_model_delegation;
    DELETE FROM openmontage_job_link;
  `);
});

after(() => {
  getDatabase().exec(`
    DELETE FROM openmontage_job_projection;
    DELETE FROM openmontage_model_delegation;
    DELETE FROM openmontage_job_link;
  `);
});

function createLink() {
  return createOpenMontageJobLinkSync({
    workspaceId: "default",
    employeeId: "employee-1",
    runtimeId: "runtime-guard-1",
    runtimeCredentialId: "00000000-0000-4000-8000-000000000011",
    rootTaskId: "task-guard-1",
    conversationId: "conversation-guard-1",
    sourceInvocationId: "source-guard-1",
    traceId: "trace-guard-1",
    snapshot: {
      schemaVersion: 1,
      jobId: "om_job_guard_1",
      status: "QUEUED",
      workflow: {
        name: "animated-explainer",
        version: "2.0",
        stages: [{ code: "research", labelCode: "stage.research", approvalRequired: false }],
      },
      stages: [{
        code: "research",
        labelCode: "stage.research",
        approvalRequired: false,
        approvalStatus: "NOT_REQUIRED",
        status: "PENDING",
        attempt: 0,
      }],
      currentStage: null,
      lastSequence: 1,
      createdAt: "2026-08-06T10:00:00Z",
      updatedAt: "2026-08-06T10:00:00Z",
    },
    delegation: {
      delegationId: "00000000-0000-4000-8000-000000000012",
      runtimeCredentialId: "00000000-0000-4000-8000-000000000011",
      modelsTenantId: "00000000-0000-4000-8000-000000000013",
      modelsTeamId: "00000000-0000-4000-8000-000000000014",
      mcpConnectionId: "mcp-guard-1",
      secretRef: "vault://guard",
      spendLimit: "2",
      currency: "CNY",
      status: "active",
      expiresAt: "2099-08-06T10:00:00Z",
    },
  });
}

test("runtime purge guard blocks before remote reads while a Job is running", async () => {
  createLink();
  let remoteReads = 0;
  await assert.rejects(
    assertOpenMontageRuntimePurgeableAsync(
      { workspaceId: "default", runtimeId: "runtime-guard-1" },
      { readRemoteDelegation: async () => { remoteReads += 1; return { status: "revoked", reservedSpend: 0, providerReconciledThrough: "2026-08-06T10:00:00Z" }; } },
    ),
    (error: unknown) => error instanceof OpenMontagePurgeBlockedError,
  );
  assert.equal(remoteReads, 0);
});

test("MCP purge guard refreshes models status and only passes finalized delegation", async () => {
  createLink();
  const db = getDatabase();
  db.prepare("UPDATE openmontage_job_projection SET status = 'SUCCEEDED' WHERE job_id = ?").run("om_job_guard_1");
  await assertOpenMontageMcpPurgeableAsync(
    { workspaceId: "default", connectionId: "mcp-guard-1" },
    { readRemoteDelegation: async () => ({ status: "revoked", reservedSpend: 0, providerReconciledThrough: "2026-08-06T10:01:00Z" }) },
  );
  assert.equal(db.prepare("SELECT status FROM openmontage_model_delegation WHERE job_id = ?").get("om_job_guard_1").status, "revoked");
});
