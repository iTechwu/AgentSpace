import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  getDatabase,
  insertRemoteTokenUsageIfAbsentSync,
  recordOpenMontagePendingTokenUsageSync,
  voidOpenMontagePendingTokenUsageSync,
} from "./index.ts";

const createdIds: string[] = [];

test("OpenMontage token usage is projected with immutable attribution before reconciliation", () => {
  const record = recordOpenMontagePendingTokenUsageSync({
    workspaceId: "default",
    employeeId: "employee-projection-test",
    runtimeId: "runtime-projection-test",
    runtimeCredentialId: "credential-projection-test",
    delegationId: "delegation-projection-test",
    jobId: "job-projection-test",
    pipelineStage: "render",
    sourceInvocationId: "source-projection-test",
    modelInvocationId: `model-projection-test-${Date.now()}`,
  });
  createdIds.push(record.id);
  assert.equal(record.billingStatus, "pending_reconciliation");
  assert.equal(record.employeeId, "employee-projection-test");
  assert.equal(record.runtimeId, "runtime-projection-test");
  assert.equal(record.jobId, "job-projection-test");
  assert.equal(record.pipelineStage, "render");
  assert.equal(record.sourceInvocationId, "source-projection-test");
});

test("delegated token usage rejects incomplete snapshots", () => {
  assert.throws(
    () => recordOpenMontagePendingTokenUsageSync({
      workspaceId: "default",
      employeeId: "employee-projection-test",
      runtimeId: "runtime-projection-test",
      runtimeCredentialId: "credential-projection-test",
      delegationId: "delegation-projection-test",
      jobId: "job-projection-test",
      pipelineStage: "render",
      sourceInvocationId: "source-projection-test",
      modelInvocationId: "",
    }),
    /modelInvocationId/,
  );
});

test("voided OpenMontage admission rows remain idempotent for late models usage", () => {
  const modelInvocationId = `model-voided-${Date.now()}`;
  const pending = recordOpenMontagePendingTokenUsageSync({
    workspaceId: "default",
    employeeId: "employee-voided-test",
    runtimeId: "runtime-voided-test",
    runtimeCredentialId: "credential-voided-test",
    delegationId: "delegation-voided-test",
    jobId: "job-voided-test",
    pipelineStage: "render",
    sourceInvocationId: "source-voided-test",
    modelInvocationId,
  });
  createdIds.push(pending.id);
  assert.equal(voidOpenMontagePendingTokenUsageSync({
    workspaceId: "default",
    jobId: "job-voided-test",
    reason: "cancelled_without_provider_usage",
  }), 1);

  const replay = insertRemoteTokenUsageIfAbsentSync({
    workspaceId: "default",
    agentId: "employee-voided-test",
    modelId: "glm-5.2",
    runtimeCredentialId: "credential-voided-test",
    gatewayRequestId: "provider-request-after-retry",
    gatewayUsageId: "provider-usage-after-retry",
    delegationId: "delegation-voided-test",
    employeeId: "employee-voided-test",
    runtimeId: "runtime-voided-test",
    jobId: "job-voided-test",
    pipelineStage: "render",
    sourceInvocationId: "source-voided-test",
    modelInvocationId,
    actualCostUsd: 0.42,
    currency: "USD",
    inputTokens: 12,
    outputTokens: 34,
  });
  assert.equal(replay.inserted, false);
  assert.equal(replay.record.id, pending.id);
  assert.equal(replay.record.billingStatus, "reconciled");
  assert.equal(replay.record.modelId, "glm-5.2");
  assert.equal(replay.record.actualCostUsd, 0.42);
});

after(() => {
  const db = getDatabase();
  for (const id of createdIds) db.prepare("DELETE FROM token_usage WHERE id = ?").run(id);
});
