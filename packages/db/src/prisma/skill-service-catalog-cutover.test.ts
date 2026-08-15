// Unit tests for the skill-service-catalog pg 原型 cutover runner
// (Phase 2 13 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listSkillServiceCatalogSync } from "../skill-services.ts";
import {
  isSkillServiceCatalogAsyncReadEnabled,
} from "./skill-service-catalog-async.ts";
import {
  listSkillServiceCatalogCutover,
  type ListSkillServiceCatalogCutoverMetric,
} from "./skill-service-catalog-cutover.ts";

const ORIGINAL_ASYNC = process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED;
  delete process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED;
  else process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED;
  else process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listSkillServiceCatalogCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isSkillServiceCatalogAsyncReadEnabled(), false);
  const metrics: ListSkillServiceCatalogCutoverMetric[] = [];
  const result = await listSkillServiceCatalogCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listSkillServiceCatalogSync("default"));
  assert.equal(metrics.length, 0);
});

test("listSkillServiceCatalogCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED = "1";
  delete process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED;

  const metrics: ListSkillServiceCatalogCutoverMetric[] = [];
  const result = await listSkillServiceCatalogCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listSkillServiceCatalogSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listSkillServiceCatalogCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED = "1";
  process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED = "1";

  const metrics: ListSkillServiceCatalogCutoverMetric[] = [];
  const result = await listSkillServiceCatalogCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});