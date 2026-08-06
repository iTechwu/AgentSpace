import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getDatabase, recordOpenMontagePendingTokenUsageSync } from "./index.ts";

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

after(() => {
  const db = getDatabase();
  for (const id of createdIds) db.prepare("DELETE FROM token_usage WHERE id = ?").run(id);
});
