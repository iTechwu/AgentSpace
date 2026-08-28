import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPrismaTransactionConflictKind,
  isPrismaTransactionConflict,
  retryPrismaTransaction,
  runWithPrismaTransactionRetryCapture,
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

test("transaction retry classifies 40P01 as deadlock and flags exhausted conflicts", async () => {
  const events: PrismaTransactionRetryEvent[] = [];
  setPrismaTransactionRetryObserver((event) => events.push(event));
  try {
    const error = conflictError("40P01");
    await assert.rejects(
      retryPrismaTransaction(() => Promise.reject(error), { scope: "workflow-materialization", maxAttempts: 1 }),
      (thrown: unknown) => thrown === error,
    );
    // 耗尽终态也必须上报（exhausted=true）：该冲突只剩最终错误可观察，
    // 不上报会让 deadlockRate 被低估成纯 errorRate。
    assert.deepEqual(events, [
      { scope: "workflow-materialization", attempt: 1, kind: "deadlock", exhausted: true },
    ]);
    assert.equal(classifyPrismaTransactionConflictKind(error), "deadlock");
  } finally {
    setPrismaTransactionRetryObserver(undefined);
  }
});

test("transaction retry exhaustion after retries reports every attempt including the final one", async () => {
  const events: PrismaTransactionRetryEvent[] = [];
  setPrismaTransactionRetryObserver(undefined);
  const error = conflictError("P2034");
  await assert.rejects(
    runWithPrismaTransactionRetryCapture(events, () => retryPrismaTransaction(
      () => Promise.reject(error),
      { scope: "workflow-dispatcher", maxAttempts: 3, baseDelayMs: 0 },
    )),
    (thrown: unknown) => thrown === error,
  );
  assert.deepEqual(events, [
    { scope: "workflow-dispatcher", attempt: 1, kind: "serialization" },
    { scope: "workflow-dispatcher", attempt: 2, kind: "serialization" },
    { scope: "workflow-dispatcher", attempt: 3, kind: "serialization", exhausted: true },
  ]);
});

test("per-call capture keeps concurrent operations' conflict events isolated", async () => {
  // 两个并发的捕获上下文：事件只进各自缓冲，不跨调用误归属。
  const dispatcherEvents: PrismaTransactionRetryEvent[] = [];
  const materializationEvents: PrismaTransactionRetryEvent[] = [];
  const dispatcherTask = (async () => {
    await runWithPrismaTransactionRetryCapture(dispatcherEvents, () => retryPrismaTransaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw conflictError("P2034");
    }, { scope: "workflow-dispatcher", maxAttempts: 1, baseDelayMs: 0 }));
  })().catch(() => undefined);
  const materializationTask = runWithPrismaTransactionRetryCapture(materializationEvents, () => retryPrismaTransaction(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw conflictError("40P01");
  }, { scope: "workflow-materialization", maxAttempts: 1, baseDelayMs: 0 })).catch(() => undefined);
  await Promise.all([dispatcherTask, materializationTask]);
  assert.deepEqual(dispatcherEvents.map((event) => event.scope), ["workflow-dispatcher"]);
  assert.deepEqual(materializationEvents.map((event) => event.scope), ["workflow-materialization"]);
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
