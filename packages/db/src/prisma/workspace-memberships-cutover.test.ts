// Unit tests for the workspace-memberships list cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import {
  listWorkspaceMembershipsSync,
} from "../workspace-memberships.ts";
import {
  isWorkspaceMembershipsAsyncReadEnabled,
} from "./workspace-memberships-async.ts";
import {
  listWorkspaceMembershipsCutover,
  type ListWorkspaceMembershipsCutoverMetric,
} from "./workspace-memberships-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED;
  delete process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED;
  else process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED;
  else process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listWorkspaceMembershipsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkspaceMembershipsAsyncReadEnabled(), false);
  const metrics: ListWorkspaceMembershipsCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkspaceMembershipsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listWorkspaceMembershipsCutover returns correct rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED;

  const metrics: ListWorkspaceMembershipsCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkspaceMembershipsSync("default"));
  assert.equal(metrics.length, 1);
  const m = metrics[0]!;
  assert.equal(m.mismatch, 0);
  assert.ok(m.source === "primary" || m.source === "fallback");
});

test("listWorkspaceMembershipsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED = "1";
  process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkspaceMembershipsCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkspaceMembershipsSync("default"));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});