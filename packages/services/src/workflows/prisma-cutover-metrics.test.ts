import assert from "node:assert/strict";
import test from "node:test";
import { retryPrismaTransaction } from "@dofe-agent/db";
import { observeWorkflowPrismaWrite } from "./prisma-cutover-metrics.ts";

test("workflow Prisma write metrics never claim an unexecuted shadow comparison", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  const clock = [100, 125];
  const result = await observeWorkflowPrismaWrite(
    { domain: "workflow-dispatcher", operation: "outbox.batch" },
    async () => "ok",
    {
      emitMetric: (_context, metric) => metrics.push(metric),
      now: () => clock.shift() ?? 125,
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(metrics, [{
    source: "primary",
    mismatch: 0,
    shadowCompared: 0,
    durationMs: 25,
    fallbackInvoked: 0,
    sampleCount: 1,
    errorCount: 0,
    deadlockCount: 0,
    p2034Count: 0,
  }]);
});

test("workflow Prisma write metrics preserve transaction errors for SLO classification", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  await assert.rejects(
    observeWorkflowPrismaWrite(
      { domain: "workflow-materialization", operation: "scheduler.tick" },
      async () => { throw new Error("P2034: could not serialize access"); },
      { emitMetric: (_context, metric) => metrics.push(metric), now: () => 100 },
    ),
    /P2034/,
  );

  assert.equal(metrics[0]?.shadowCompared, 0);
  assert.equal(metrics[0]?.error, "P2034: could not serialize access");
  assert.equal(metrics[0]?.errorCount, 1);
  assert.equal(metrics[0]?.sampleCount, 1);
  // 直抛（未经 retry 包装）的冲突没有已捕获事件：不硬填 0，省略字段让
  // 窗口层按错误消息分类兜底进入 p2034Rate。
  assert.equal(metrics[0]?.p2034Count, undefined);
  assert.equal(metrics[0]?.deadlockCount, undefined);
});

test("exhausted transaction conflicts count into the failure sample's conflict rates", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  await assert.rejects(
    observeWorkflowPrismaWrite(
      { domain: "workflow-dispatcher", operation: "outbox.batch" },
      () => retryPrismaTransaction(async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }, { scope: "workflow-dispatcher", maxAttempts: 3, baseDelayMs: 0 }),
      { emitMetric: (_context, metric) => metrics.push(metric), now: () => 100 },
    ),
    /deadlock/,
  );

  // 3 次尝试全部 40P01 冲突后耗尽：错误照抛，同时每次冲突（含终态）
  // 都计入 deadlockCount——不能只剩 errorRate。
  assert.equal(metrics[0]?.errorCount, 1);
  assert.equal(metrics[0]?.deadlockCount, 3);
  assert.equal(metrics[0]?.p2034Count, 0);
});

test("batch summaries carry structured item failures into the SLO sample", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  await observeWorkflowPrismaWrite(
    { domain: "workflow-dispatcher", operation: "outbox.batch" },
    async () => ({
      publishedOutboxIds: ["a", "b", "c"],
      failedOutboxIds: ["d"],
      leaseConflictOutboxIds: ["e"],
    }),
    {
      emitMetric: (_context, metric) => metrics.push(metric),
      now: () => 100,
      summarizeResult: (result: { publishedOutboxIds: string[]; failedOutboxIds: string[] }) => ({
        sampleCount: result.publishedOutboxIds.length + result.failedOutboxIds.length,
        errorCount: result.failedOutboxIds.length,
      }),
    },
  );

  assert.equal(metrics[0]?.sampleCount, 4);
  assert.equal(metrics[0]?.errorCount, 1);
  assert.equal(metrics[0]?.error, undefined);
});

test("batch summaries carry structured event-order observations into the SLO sample", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  await observeWorkflowPrismaWrite(
    { domain: "workflow-dispatcher", operation: "outbox.batch" },
    async () => ({
      publishedOutboxIds: ["a"],
      failedOutboxIds: [],
      observability: { eventOrder: { comparedCount: 1, driftCount: 1 } },
    }),
    {
      emitMetric: (_context, metric) => metrics.push(metric),
      now: () => 100,
      summarizeResult: (result: {
        publishedOutboxIds: string[];
        failedOutboxIds: string[];
        observability: { eventOrder: { comparedCount: number; driftCount: number } };
      }) => ({
        sampleCount: result.publishedOutboxIds.length,
        errorCount: result.failedOutboxIds.length,
        eventOrder: result.observability.eventOrder,
      }),
    },
  );
  assert.deepEqual(metrics[0]?.eventOrder, { comparedCount: 1, driftCount: 1 });
});

test("successfully retried transaction conflicts surface as p2034/deadlock counts", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  let attempts = 0;
  const result = await observeWorkflowPrismaWrite(
    { domain: "workflow-dispatcher", operation: "outbox.batch" },
    () => retryPrismaTransaction(async () => {
      attempts += 1;
      if (attempts === 1) {
        // 首试 P2034 冲突，重试后成功：外部只见成功，冲突只经观察者上报。
        throw Object.assign(new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction."), { code: "P2034" });
      }
      return "retried-ok";
    }, { scope: "workflow-dispatcher", maxAttempts: 2, baseDelayMs: 0 }),
    { emitMetric: (_context, metric) => metrics.push(metric), now: () => 100 },
  );

  assert.equal(result, "retried-ok");
  // 第一次尝试冲突 → 观察者记一次 serialization；最终结果成功但不再是“无冲突”样本。
  assert.equal(metrics[0]?.p2034Count, 1);
  assert.equal(metrics[0]?.deadlockCount, 0);
  assert.equal(metrics[0]?.errorCount, 0);
});

test("deadlock retries attribute to the observed domain only", async () => {
  const metrics: Array<Record<string, unknown>> = [];
  await observeWorkflowPrismaWrite(
    { domain: "workflow-materialization", operation: "scheduler.tick" },
    async () => {
      // 别的域（coordinator）发生的冲突不得混入本域样本。
      await retryPrismaTransaction(async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }, { scope: "workflow-coordinator", maxAttempts: 2, baseDelayMs: 0 }).catch(() => undefined);
      return "ok";
    },
    { emitMetric: (_context, metric) => metrics.push(metric), now: () => 100 },
  );

  assert.equal(metrics[0]?.deadlockCount, 0);
  assert.equal(metrics[0]?.p2034Count, 0);
});
