import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPrismaTransactionConflictKind,
  isPrismaTransactionConflict,
  retryPrismaTransaction,
  setPrismaTransactionRetryObserver,
  type PrismaTransactionRetryEvent,
} from "./transaction-retry.ts";

function conflictError(code: string): Error & { code: string } {
  const error = Object.assign(new Error(`prisma conflict ${code}`), { code });
  return error;
}

test("transaction retry reports recoverable conflicts to the observer per attempt", async () => {
  const events: PrismaTransactionRetryEvent[] = [];
  setPrismaTransactionRetryObserver((event) => events.push(event));
  try {
    let calls = 0;
    const result = await retryPrismaTransaction(async () => {
      calls += 1;
      if (calls < 3) throw conflictError("P2034");
      return "ok";
    }, { scope: "workflow-dispatcher", baseDelayMs: 0 });
    assert.equal(result, "ok");
    assert.deepEqual(events, [
      { scope: "workflow-dispatcher", attempt: 1, kind: "serialization" },
      { scope: "workflow-dispatcher", attempt: 2, kind: "serialization" },
    ]);
  } finally {
    setPrismaTransactionRetryObserver(undefined);
  }
});

test("transaction retry classifies 40P01 as deadlock and does not notify on final failure", async () => {
  const events: PrismaTransactionRetryEvent[] = [];
  setPrismaTransactionRetryObserver((event) => events.push(event));
  try {
    const error = conflictError("40P01");
    await assert.rejects(
      retryPrismaTransaction(() => Promise.reject(error), { scope: "workflow-materialization", maxAttempts: 1 }),
      (thrown: unknown) => thrown === error,
    );
    // 单次尝试没有重试机会，观察者不收到事件。
    assert.deepEqual(events, []);
    assert.equal(classifyPrismaTransactionConflictKind(error), "deadlock");
  } finally {
    setPrismaTransactionRetryObserver(undefined);
  }
});

test("transaction retry observer failures never break the retry loop", async () => {
  setPrismaTransactionRetryObserver(() => { throw new Error("observer down"); });
  try {
    let calls = 0;
    const result = await retryPrismaTransaction(async () => {
      calls += 1;
      if (calls < 2) throw conflictError("40001");
      return 42;
    }, { baseDelayMs: 0 });
    assert.equal(result, 42);
  } finally {
    setPrismaTransactionRetryObserver(undefined);
  }
});

test("non-conflict errors bypass the observer and propagate immediately", async () => {
  const events: PrismaTransactionRetryEvent[] = [];
  setPrismaTransactionRetryObserver((event) => events.push(event));
  try {
    const error = new Error("workflow_outbox_lease_conflict");
    await assert.rejects(
      retryPrismaTransaction(() => Promise.reject(error), { baseDelayMs: 0 }),
      (thrown: unknown) => thrown === error,
    );
    assert.deepEqual(events, []);
    assert.equal(isPrismaTransactionConflict(error), false);
  } finally {
    setPrismaTransactionRetryObserver(undefined);
  }
});
