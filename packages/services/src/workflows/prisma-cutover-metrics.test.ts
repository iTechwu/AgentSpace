import assert from "node:assert/strict";
import test from "node:test";
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
});
