import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  getDatabase,
  upsertMcpCatalogItemSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import { resetWorkspaceStateSync } from "../index.ts";
import { computeSkillReleaseLockSync, diffSkillArtifactsSync, isSkillUpgradeApprovalRequiredSync } from "./release.ts";

const sha = (fill: string) => fill.repeat(64);

after(() => {
  // Best-effort cleanup so the shared test DB does not leak catalog rows.
  const db = getDatabase();
  db.prepare("DELETE FROM skill_service_catalog WHERE workspace_id = ?").run("default");
  db.prepare("DELETE FROM mcp_catalog_item WHERE workspace_id = ?").run("default");
});

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    artifact: { name: "render", version: "1.0.0" },
    files: [
      { path: "SKILL.md", sha256: sha("a"), size: 10, mediaType: "text/markdown", mode: "0644" },
      { path: "scripts/render.py", sha256: sha("b"), size: 42, mediaType: "text/x-python", mode: "0755" },
    ],
    dependencies: [{ manager: "npm", name: "left-pad", version: "1.3.0" }],
    ...overrides,
  });
}

test("diffSkillArtifactsSync reports content-only changes as non-breaking", () => {
  const diff = diffSkillArtifactsSync({
    fromManifestJson: manifest(),
    toManifestJson: manifest({
      files: [
        { path: "SKILL.md", sha256: sha("c"), size: 11, mediaType: "text/markdown", mode: "0644" },
        { path: "scripts/render.py", sha256: sha("b"), size: 42, mediaType: "text/x-python", mode: "0755" },
      ],
    }),
  });
  assert.ok(diff.categories.some((c) => c.category === "content" && c.changes.length > 0));
  assert.equal(diff.breaking, false);
  assert.equal(isSkillUpgradeApprovalRequiredSync(diff), false);
});

test("diffSkillArtifactsSync flags a new executable script as breaking", () => {
  const diff = diffSkillArtifactsSync({
    fromManifestJson: manifest(),
    toManifestJson: manifest({
      files: [
        { path: "SKILL.md", sha256: sha("a"), size: 10, mediaType: "text/markdown", mode: "0644" },
        { path: "scripts/render.py", sha256: sha("b"), size: 42, mediaType: "text/x-python", mode: "0755" },
        { path: "scripts/extra.sh", sha256: sha("d"), size: 5, mediaType: "text/x-shellscript", mode: "0755" },
      ],
    }),
  });
  assert.ok(diff.categories.some((c) => c.category === "content" && c.changes.some((change) => change.includes("extra.sh"))));
  assert.equal(diff.breaking, true);
});

test("diffSkillArtifactsSync flags an existing executable script content change as breaking", () => {
  const diff = diffSkillArtifactsSync({
    fromManifestJson: manifest(),
    toManifestJson: manifest({
      files: [
        { path: "SKILL.md", sha256: sha("a"), size: 10, mediaType: "text/markdown", mode: "0644" },
        { path: "scripts/render.py", sha256: sha("c"), size: 42, mediaType: "text/x-python", mode: "0755" },
      ],
    }),
  });
  assert.ok(diff.categories.some((c) => c.category === "execution" && c.changes.some((change) => change.includes("scripts/render.py"))));
  assert.equal(diff.breaking, true);
});

test("diffSkillArtifactsSync flags dependency changes as breaking config", () => {
  const diff = diffSkillArtifactsSync({
    fromManifestJson: manifest(),
    toManifestJson: manifest({
      dependencies: [
        { manager: "npm", name: "left-pad", version: "1.3.0" },
        { manager: "npm", name: "is-odd", version: "3.0.1" },
      ],
    }),
  });
  assert.ok(diff.categories.some((c) => c.category === "config" && c.changes.some((change) => change.includes("is-odd"))));
  assert.equal(diff.breaking, true);
});

test("diffSkillArtifactsSync flags capability (network permission) changes", () => {
  const withCapability = manifest({
    capabilities: [{ kind: "mcp", catalogSlug: "github", requiredTools: ["search_issues"] }],
  });
  const diff = diffSkillArtifactsSync({ fromManifestJson: manifest(), toManifestJson: withCapability });
  assert.ok(diff.categories.some((c) => c.category === "network_permissions" && c.changes.length > 0));
  assert.equal(diff.breaking, true);
});

test("diffSkillArtifactsSync flags service template changes", () => {
  const fromService = manifest({ services: [{ catalogSlug: "document-renderer", templateVersion: "2.1.0", required: true }] });
  const toService = manifest({ services: [{ catalogSlug: "document-renderer", templateVersion: "2.2.0", required: true }] });
  const diff = diffSkillArtifactsSync({ fromManifestJson: fromService, toManifestJson: toService });
  assert.ok(diff.categories.some((c) => c.category === "services" && c.changes.some((change) => change.includes("2.1.0 → 2.2.0"))));
  assert.equal(diff.breaking, true);
});

test("computeSkillReleaseLockSync derives a content-addressed dependency lock", () => {
  const lock = computeSkillReleaseLockSync({
    id: "art-1",
    workspaceId: "default",
    digest: sha("e"),
    name: "render",
    version: "1.0.0",
    manifestVersion: 1,
    manifestJson: manifest(),
    sourceType: "manual",
    provenanceJson: "{}",
    fileCount: 2,
    totalSizeBytes: 52,
    legacyIncomplete: false,
    createdAt: new Date().toISOString(),
  });
  assert.equal(lock.artifactDigest, sha("e"));
  assert.equal(lock.packageSchemaVersion, 1);
  assert.equal(lock.dependencyLockDigest.length, 64);
  assert.equal(lock.dependencyLockDigest, computeSkillReleaseLockSync({
    id: "art-2",
    workspaceId: "default",
    digest: sha("e"),
    name: "render",
    version: "1.0.0",
    manifestVersion: 1,
    manifestJson: manifest(),
    sourceType: "github",
    provenanceJson: "{}",
    fileCount: 2,
    totalSizeBytes: 52,
    legacyIncomplete: false,
    createdAt: new Date().toISOString(),
  }).dependencyLockDigest); // provenance does not perturb the lock
  assert.equal(lock.lockDigest.length, 64);
});

function artifactWithServicesAndCapabilities(): Parameters<typeof computeSkillReleaseLockSync>[0] {
  return {
    id: "art-full",
    workspaceId: "default",
    digest: sha("e"),
    name: "full",
    version: "1.0.0",
    manifestVersion: 1,
    manifestJson: manifest({
      services: [{ catalogSlug: "document-renderer", templateVersion: "2.1.0", required: true }],
      capabilities: [{ kind: "mcp", catalogSlug: "github", requiredTools: ["search_issues"] }],
    }),
    sourceType: "manual",
    provenanceJson: "{}",
    fileCount: 2,
    totalSizeBytes: 52,
    legacyIncomplete: false,
    createdAt: new Date().toISOString(),
  };
}

test("computeSkillReleaseLockSync populates service + MCP fields from catalogs", () => {
  resetWorkspaceStateSync("default");
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: sha("img"),
    configSchemaVersion: 3,
  });
  upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug: "github",
    transport: "streamable_http",
    displayName: "GitHub",
    declaredToolsJson: JSON.stringify([
      { name: "search_issues", description: "Search issues", inputSchema: { type: "object" } },
      { name: "get_issue", description: "Get issue", inputSchema: { type: "object" } },
    ]),
  });

  const lock = computeSkillReleaseLockSync(artifactWithServicesAndCapabilities());

  assert.equal(lock.serviceTemplateVersions["document-renderer"], "2.1.0");
  assert.equal(lock.serviceImageDigests["document-renderer"], sha("img"));
  assert.equal(lock.serviceConfigSchemaVersions["document-renderer"], 3);
  assert.equal(lock.mcpToolFingerprints["github"]?.length, 64);
  assert.equal(lock.lockDigest.length, 64);
});

test("computeSkillReleaseLockSync lockDigest is reproducible and provenance-independent", () => {
  resetWorkspaceStateSync("default");
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: sha("img"),
    configSchemaVersion: 3,
  });
  upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug: "github",
    transport: "streamable_http",
    displayName: "GitHub",
    declaredToolsJson: JSON.stringify([{ name: "search_issues", description: "Search issues" }]),
  });

  const first = computeSkillReleaseLockSync(artifactWithServicesAndCapabilities());
  const second = computeSkillReleaseLockSync({
    ...artifactWithServicesAndCapabilities(),
    id: "art-other",
    sourceType: "github",
  });
  assert.equal(second.lockDigest, first.lockDigest, "lock digest is stable across provenance");

  // Changing a dependency perturbs the lock digest.
  const changed = computeSkillReleaseLockSync({
    ...artifactWithServicesAndCapabilities(),
    manifestJson: manifest({
      dependencies: [
        { manager: "npm", name: "left-pad", version: "1.3.0" },
        { manager: "npm", name: "is-odd", version: "3.0.1" },
      ],
      services: [{ catalogSlug: "document-renderer", templateVersion: "2.1.0", required: true }],
      capabilities: [{ kind: "mcp", catalogSlug: "github", requiredTools: ["search_issues"] }],
    }),
  });
  assert.notEqual(changed.lockDigest, first.lockDigest, "a dependency change perturbs the lock digest");
});
