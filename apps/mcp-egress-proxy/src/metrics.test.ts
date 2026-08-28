import assert from "node:assert/strict";
import test from "node:test";
import { McpEgressMetrics } from "./metrics.ts";

test("metrics count requests, accepts, rejects, revokes and latency buckets", () => {
  const metrics = new McpEgressMetrics();
  metrics.recordRequest();
  metrics.recordRequest();
  metrics.recordAccept(80);
  metrics.recordAccept(300);
  metrics.recordReject();
  metrics.recordRevoke();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requestsTotal, 2);
  assert.equal(snapshot.acceptedTotal, 2);
  assert.equal(snapshot.rejectedTotal, 1);
  assert.equal(snapshot.revokedTotal, 1);
  const buckets = Object.fromEntries(snapshot.latencyBuckets.map((bucket) => [bucket.label, bucket.count]));
  assert.equal(buckets["le=100"], 1);
  assert.equal(buckets["le=500"], 1);
  assert.equal(buckets["le=+Inf"], 0);
  assert.ok(snapshot.startedAt);
});

test("latency above 2000ms lands in the +Inf bucket", () => {
  const metrics = new McpEgressMetrics();
  metrics.recordAccept(2500);
  const snapshot = metrics.snapshot();
  const inf = snapshot.latencyBuckets.find((bucket) => bucket.label === "le=+Inf")!;
  assert.equal(inf.count, 1);
});
