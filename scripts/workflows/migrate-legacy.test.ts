import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planLegacyMigration } from "../../packages/services/src/workflows/migration.ts";

test("maps a scheduled task with an assignee to a one-node workflow plan", () => {
  const result = planLegacyMigration({
    workspaceId: "default",
    scheduledTasks: [{
      id: "st-1",
      title: "Morning brief",
      assignee: "Atlas",
      scheduledAt: "2026-08-07T01:00:00Z",
      repeat: "daily",
      status: "active",
    }],
    automationRules: [],
  });

  assert.equal(result.actions[0]?.kind, "create_workflow");
  assert.equal(result.actions[0]?.sourceId, "st-1");
  assert.equal(result.actions[0]?.kind === "create_workflow" ? result.actions[0].employeeId : undefined, "emp-atlas");
  assert.deepEqual(result.counts, { create_workflow: 1, disabled_draft: 0, legacy_adapter: 0 });
});

test("does not silently enable unassigned or dynamic legacy rules", () => {
  const result = planLegacyMigration({
    workspaceId: "default",
    scheduledTasks: [{ id: "st-2", title: "Unknown", scheduledAt: "2026-08-07T01:00:00Z", status: "active" }],
    automationRules: [{ id: "ar-1", trigger: { type: "message_received", config: {} }, actions: [{ type: "webhook", config: {} }] }],
  });

  assert.equal(result.actions.find((item) => item.sourceId === "st-2")?.kind, "disabled_draft");
  assert.equal(result.actions.find((item) => item.sourceId === "ar-1")?.kind, "legacy_adapter");
});

test("strict employee resolution disables unknown legacy assignees", () => {
  const result = planLegacyMigration({
    workspaceId: "default",
    scheduledTasks: [{ id: "st-3", title: "Unknown", assignee: "Missing", scheduledAt: "2026-08-07T01:00:00Z" }],
    automationRules: [],
    employees: [{ id: "emp-atlas", name: "Atlas" }],
    strictEmployeeResolution: true,
  });
  assert.equal(result.actions[0]?.kind, "disabled_draft");
});

test("CLI defaults to a sanitized dry-run report", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-migration-"));
  const inputFile = join(directory, "legacy.json");
  try {
    writeFileSync(inputFile, JSON.stringify({
      scheduledTasks: [],
      automationRules: [{
        id: "ar-secret",
        name: "Webhook rule",
        trigger: { type: "message_received", config: { token: "do-not-print" } },
        actions: [{ type: "webhook", config: { secret: "do-not-print" } }],
      }],
      activeEmployees: [],
    }));
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types",
      "scripts/workflows/migrate-legacy.ts",
      "--workspace-id",
      "default",
      "--input-file",
      inputFile,
    ], { cwd: process.cwd(), encoding: "utf8" });
    const report = JSON.parse(output) as { mode: string; plan: { legacy_adapter: number }; report: { dryRun: boolean } };
    assert.equal(report.mode, "dry-run");
    assert.equal(report.plan.legacy_adapter, 1);
    assert.equal(report.report.dryRun, true);
    assert.equal(output.includes("do-not-print"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
