import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import {
  deleteWorkspaceServiceSecretSync,
  listWorkspaceServiceSecretsSync,
  readWorkspaceServiceSecretSync,
  upsertSkillServiceCatalogSync,
  upsertWorkspaceServiceSecretSync,
} from "./index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM workspace_service_secret").run();
    db.prepare("DELETE FROM managed_skill_service_operation").run();
    db.prepare("DELETE FROM skill_service_binding").run();
    db.prepare("DELETE FROM managed_skill_service").run();
    db.prepare("DELETE FROM skill_service_catalog").run();
    db.prepare("DELETE FROM skill_installation").run();
    db.prepare("DELETE FROM skill_artifact").run();
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(DEFAULT_WORKSPACE_ID, "default", "test", now, now);
  });
});

function seedCatalog(): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: `secret-renderer-${randomLikeId().slice(0, 6)}`,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    secretFieldsJson: JSON.stringify(["RENDER_LICENSE"]),
  }).id;
}

test("service secret CRUD round-trips with an upsert-overwrite and delete", () => {
  const catalogId = seedCatalog();

  const first = upsertWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "RENDER_LICENSE",
    encryptedValue: "envelope:v1",
  });
  assert.equal(first.name, "RENDER_LICENSE");
  assert.equal(first.encryptedValue, "envelope:v1");

  // Overwrite keeps the same row, updates the value.
  upsertWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "RENDER_LICENSE",
    encryptedValue: "envelope:v2",
  });
  const listed = listWorkspaceServiceSecretsSync(catalogId, "default");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.encryptedValue, "envelope:v2");

  const reread = readWorkspaceServiceSecretSync(listed[0]!.id, "default");
  assert.equal(reread?.encryptedValue, "envelope:v2");

  // A different name for the same catalog is a separate row.
  upsertWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "API_KEY",
    encryptedValue: "envelope:v3",
  });
  assert.equal(listWorkspaceServiceSecretsSync(catalogId, "default").length, 2);

  assert.equal(
    deleteWorkspaceServiceSecretSync({ workspaceId: "default", serviceCatalogId: catalogId, name: "RENDER_LICENSE" }),
    true,
  );
  assert.equal(listWorkspaceServiceSecretsSync(catalogId, "default").length, 1);
});
