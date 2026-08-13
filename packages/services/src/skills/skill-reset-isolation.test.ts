import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { resetWorkspaceStateSync } from "../index.ts";

/**
 * Regression gate for shared-test-database isolation: a workspace reset must
 * clear the ENTIRE workspace-scoped skill chain (artifacts, installations,
 * approvals, service catalog/services, drafts, import events, runner
 * invocations), not just skill/agent_skill. Rows left behind collide with the
 * next test file via UNIQUE(workspace_id, digest/name/…) and block deletes
 * via RESTRICT foreign keys — the historical source of flaky suite runs.
 *
 * Assertions are marker-scoped (ids contain "reset-coverage") because a reset
 * legitimately re-seeds the workspace's default skill storage.
 */
test("resetWorkspaceStateSync clears the full workspace skill chain", () => {
  const ws = "reset-skills-coverage-test";
  const db = getDatabase();
  resetWorkspaceStateSync(ws);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES ('rt-reset-coverage', ?, 'test-provider', 'Reset Coverage Runtime', 'online', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO skill (id, workspace_id, name, created_at, updated_at)
     VALUES ('skill-reset-coverage', ?, 'reset-coverage-skill', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO skill_artifact (id, workspace_id, digest, name, manifest_json, created_at)
     VALUES ('artifact-reset-coverage', ?, 'digest-reset-coverage', 'reset-coverage-skill', '{}', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_artifact_file (id, artifact_id, workspace_id, path, sha256, size_bytes, media_type, created_at)
     VALUES ('artifact-file-reset-coverage', 'artifact-reset-coverage', ?, 'SKILL.md', 'sha', 1, 'text/markdown', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_artifact_binding (id, workspace_id, skill_id, artifact_digest, created_at)
     VALUES ('binding-reset-coverage', ?, 'skill-reset-coverage', 'digest-reset-coverage', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_installation (id, workspace_id, runtime_id, artifact_digest, status, revision, created_at, updated_at)
     VALUES ('installation-reset-coverage', ?, 'rt-reset-coverage', 'digest-reset-coverage', 'ready', 'rev-1', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO skill_installation_operation (id, workspace_id, runtime_id, installation_id, operation, status, created_at)
     VALUES ('operation-reset-coverage', ?, 'rt-reset-coverage', 'installation-reset-coverage', 'install', 'queued', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_installation_component (id, installation_id, kind, key, status, updated_at)
     VALUES ('component-reset-coverage', 'installation-reset-coverage', 'script', 'scripts/a.py', 'ready', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO skill_install_approval (id, workspace_id, artifact_digest, release_lock_digest, risk_decision_digest, decision, created_at)
     VALUES ('install-approval-reset-coverage', ?, 'digest-reset-coverage', 'lock-1', 'risk-1', 'approved', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_upgrade_approval (id, workspace_id, from_digest, to_digest, diff_hash, decision, created_at)
     VALUES ('upgrade-approval-reset-coverage', ?, 'from-1', 'to-1', 'diff-1', 'approved', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_runner_invocation (id, workspace_id, skill_name, artifact_digest, entrypoint_id, entrypoint_key, actor_id, actor_type, result_code, created_at)
     VALUES ('invocation-reset-coverage', ?, 'reset-coverage-skill', 'digest-reset-coverage', 'ep-1', 'scripts/a.py', 'actor-1', 'employee', 0, ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_draft (workspace_id, skill_id, draft_json, updated_at)
     VALUES (?, 'skill-reset-coverage', '{}', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_import_event (id, workspace_id, skill_name, source_type, imported_at)
     VALUES ('import-event-reset-coverage', ?, 'reset-coverage-skill', 'local', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_service_catalog (id, workspace_id, slug, template_version, deployment_type, image_digest, template_digest, created_at, updated_at)
     VALUES ('catalog-reset-coverage', ?, 'reset-coverage-service', 'v1', 'container', 'sha256:image', 'sha256:template', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO managed_skill_service (id, workspace_id, runtime_id, catalog_id, status, rollout_revision, created_at, updated_at)
     VALUES ('service-reset-coverage', ?, 'rt-reset-coverage', 'catalog-reset-coverage', 'running', 'rev-1', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO managed_skill_service_operation (id, workspace_id, runtime_id, service_id, operation, status, created_at)
     VALUES ('service-operation-reset-coverage', ?, 'rt-reset-coverage', 'service-reset-coverage', 'start', 'queued', ?)`,
  ).run(ws, now);
  db.prepare(
    `INSERT INTO skill_service_binding (installation_id, service_id, catalog_template_version, service_image_digest, endpoint_ref, health_revision, config_schema_version, created_at)
     VALUES ('installation-reset-coverage', 'service-reset-coverage', 'v1', 'sha256:image', 'endpoint', 'rev-1', 1, ?)`,
  ).run(now);

  // [table, marker column] — skill_draft has no id; the binding/component
  // tables have no workspace_id and are matched through their parent marker.
  const seeded: Array<[string, string]> = [
    ["skill", "id"],
    ["skill_artifact", "id"],
    ["skill_artifact_file", "id"],
    ["skill_artifact_binding", "id"],
    ["skill_installation", "id"],
    ["skill_installation_operation", "id"],
    ["skill_installation_component", "id"],
    ["skill_install_approval", "id"],
    ["skill_upgrade_approval", "id"],
    ["skill_runner_invocation", "id"],
    ["skill_draft", "skill_id"],
    ["skill_import_event", "id"],
    ["skill_service_catalog", "id"],
    ["managed_skill_service", "id"],
    ["managed_skill_service_operation", "id"],
    ["skill_service_binding", "service_id"],
  ];
  const markerCount = (table: string, column: string): number =>
    Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} LIKE '%reset-coverage%'`).get() as { c: number }).c,
    );

  for (const [table, column] of seeded) {
    assert.equal(markerCount(table, column), 1, `seed should insert one marker row into ${table}`);
  }

  resetWorkspaceStateSync(ws);

  for (const [table, column] of seeded) {
    assert.equal(markerCount(table, column), 0, `reset should clear the marker row from ${table}`);
  }
});
