import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase, randomLikeId, upsertSkillServiceCatalogSync, upsertWorkspaceServiceSecretSync } from "@dofe-agent/db";
import { listWorkspaceServiceSecretsSync } from "@dofe-agent/db";
import { resolveWorkspaceServiceSecretsSync, setWorkspaceServiceSecretSync } from "./secrets.ts";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

before(() => {
  process.env.NODE_ENV = "test";
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = TEST_KEY;
});

beforeEach(() => {
  getDatabase().exec("DELETE FROM workspace_service_secret");
});

/** Fresh catalog slug per test (catalog is immutable per slug — avoids cross-file pollution). */
function seedCatalog(secretFields: string[]): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: `secrets-${randomLikeId().slice(0, 6)}`,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    secretFieldsJson: JSON.stringify(secretFields),
  }).id;
}

test("set stores an encrypted value and resolve returns it decrypted", () => {
  const catalogId = seedCatalog(["RENDER_LICENSE"]);
  const result = setWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "RENDER_LICENSE",
    value: "sk-live-123",
  });
  assert.equal(result.ok, true);

  const stored = listWorkspaceServiceSecretsSync(catalogId, "default");
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.encryptedValue, "sk-live-123", "plaintext must not be stored");
  assert.ok(!stored[0]!.encryptedValue.includes("sk-live-123"));

  const resolved = resolveWorkspaceServiceSecretsSync({ workspaceId: "default", serviceCatalogId: catalogId });
  assert.deepEqual(resolved, { RENDER_LICENSE: "sk-live-123" });
});

test("set rejects a name the catalog did not declare", () => {
  const catalogId = seedCatalog(["RENDER_LICENSE"]);
  const result = setWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "UNDECLARED",
    value: "x",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not declared/);
  }
});

test("set rejects a malformed secret name", () => {
  const catalogId = seedCatalog(["RENDER_LICENSE"]);
  const result = setWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "lower-case",
    value: "x",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /env-var name/);
  }
});

test("resolve skips a corrupt entry and returns the rest", () => {
  const catalogId = seedCatalog(["RENDER_LICENSE", "API_KEY"]);
  setWorkspaceServiceSecretSync({ workspaceId: "default", serviceCatalogId: catalogId, name: "RENDER_LICENSE", value: "lic" });
  setWorkspaceServiceSecretSync({ workspaceId: "default", serviceCatalogId: catalogId, name: "API_KEY", value: "key" });

  // Corrupt one entry directly at the db layer (bad key/version).
  upsertWorkspaceServiceSecretSync({
    workspaceId: "default",
    serviceCatalogId: catalogId,
    name: "API_KEY",
    encryptedValue: "not-an-envelope",
  });

  const resolved = resolveWorkspaceServiceSecretsSync({ workspaceId: "default", serviceCatalogId: catalogId });
  assert.deepEqual(resolved, { RENDER_LICENSE: "lic" });
});
