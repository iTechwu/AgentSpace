import assert from "node:assert/strict";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  createSkillUpgradeApprovalSync,
  getDatabase,
  listManagedSkillServiceOperationsSync,
  randomLikeId,
  readActiveArtifactDigestForSkillSync,
  readSkillInstallationComponentsSync,
  setSkillInstallationStatusSync,
  setActiveArtifactDigestForSkillSync,
  updateSkillInstallationComponentStatusSync,
  upsertMcpCatalogItemSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  createSkillInstallationPlanSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
} from "../index.ts";
import {
  approveSkillUpgradeSync,
  computeSkillReleaseLockSync,
  computeSkillUpgradeDiffHashSync,
  createSkillUpgradePlanSync,
  diffSkillArtifactsSync,
  isSkillUpgradeApprovalRequiredSync,
  readSkillInstallationLockSync,
  promoteSkillUpgradeSync,
  SKILL_PROVIDER_COMPATIBILITY_REVISION,
  verifySkillInstallationLockReconstructableSync,
} from "./release.ts";
import { stableStringify } from "./package/package-digest.ts";

const sha = (fill: string) => fill.repeat(64);

after(() => {
  // Best-effort cleanup so the shared test DB does not leak catalog rows.
  const db = getDatabase();
  db.prepare("DELETE FROM skill_service_binding").run();
  db.prepare("DELETE FROM managed_skill_service_operation WHERE workspace_id = ?").run("default");
  db.prepare("DELETE FROM managed_skill_service WHERE workspace_id = ?").run("default");
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

/* ------------------------------------------------------------------ */
/* Upgrade approval gate + invariants                                   */
/* ------------------------------------------------------------------ */

function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

const ENCODER = new TextEncoder();

function buildUpgradeArtifacts(skillId?: string | null) {
  // Salt the content so each test run produces fresh digests: approvals persist
  // across runs (resetWorkspaceStateSync does not clear skill_upgrade_approval),
  // so deterministic digests would collide with a consumed approval from a
  // previous run via the UNIQUE first-write-wins.
  const salt = cryptoRandomBytes(4).toString("hex");
  const resolvedSkillId = skillId === null
    ? undefined
    : skillId ?? createWorkspaceSkillSync({ name: `Upgrade Test ${salt}` }).id;
  const first = buildAndPersistSkillArtifactSync({
    skillId: resolvedSkillId,
    name: "Upgrade Test",
    files: [
      { path: "SKILL.md", bytes: ENCODER.encode(`# Body v1 ${salt}\n`) },
      { path: "scripts/render.py", bytes: ENCODER.encode("print('v1')\n"), mode: "0755" },
    ],
  });
  const second = buildAndPersistSkillArtifactSync({
    skillId: resolvedSkillId,
    activate: false,
    name: "Upgrade Test",
    files: [
      { path: "SKILL.md", bytes: ENCODER.encode(`# Body v2 ${salt}\n`) },
      { path: "scripts/render.py", bytes: ENCODER.encode("print('v2 changed')\n"), mode: "0755" },
    ],
  });
  return { first, second };
}

function readyInstall(runtimeId: string, digest: string): { id: string } {
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });
  setSkillInstallationStatusSync({
    installationId: installation.id,
    workspaceId: "default",
    status: "ready",
    health: "healthy",
  });
  return installation;
}

function breakingDiffHash(first: { digest: string; artifact: { manifestJson: string } }, second: { digest: string; artifact: { manifestJson: string } }): string {
  return computeSkillUpgradeDiffHashSync({
    fromManifestJson: first.artifact.manifestJson,
    toManifestJson: second.artifact.manifestJson,
  });
}

test("createSkillUpgradePlanSync rejects a breaking upgrade without an approval", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = readyInstall(runtimeId, first.digest);

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id }),
    /breaking changes/,
  );
});

test("createSkillUpgradePlanSync consumes the approval exactly once", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = readyInstall(runtimeId, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({ fromDigest: first.digest, toDigest: second.digest, diffHash });

  const v2 = createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId });
  assert.equal(v2.previousReadyRevision, "v1");

  // A second plan with the same (consumed) approval must be rejected.
  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /already been consumed/,
  );
});

test("createSkillUpgradePlanSync rejects an approval from an obsolete policy version", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = readyInstall(runtimeId, first.digest);
  const approval = createSkillUpgradeApprovalSync({
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash: breakingDiffHash(first, second),
    policyVersion: "obsolete-policy",
    decision: "approved",
  });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId: approval.id }),
    /policy version/,
  );
});

test("createSkillUpgradePlanSync rejects an approval whose diffHash does not match", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = readyInstall(runtimeId, first.digest);
  const { approvalId } = approveSkillUpgradeSync({
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash: "0".repeat(64),
  });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /does not match this upgrade/,
  );
});

test("createSkillUpgradePlanSync rejects a non-ready previous installation", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = createSkillInstallationPlanSync({ runtimeId, artifactDigest: first.digest }); // still preparing
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({ fromDigest: first.digest, toDigest: second.digest, diffHash });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /not ready/,
  );
});

test("promoteSkillUpgradeSync atomically activates a ready candidate and rejects a stale cutover", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const skill = createWorkspaceSkillSync({ name: `Promote ${cryptoRandomBytes(3).toString("hex")}` });
  const { first, second } = buildUpgradeArtifacts(skill.id);
  setActiveArtifactDigestForSkillSync({ skillId: skill.id, digest: first.digest, workspaceId: "default" });
  const previous = readyInstall(runtimeId, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({
    skillId: skill.id,
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash,
  });
  const candidate = createSkillUpgradePlanSync({
    runtimeId,
    artifactDigest: second.digest,
    previousReadyInstallationId: previous.id,
    approvalId,
  });
  for (const component of readSkillInstallationComponentsSync(candidate.id)) {
    updateSkillInstallationComponentStatusSync({
      installationId: candidate.id,
      kind: component.kind,
      key: component.key,
      status: "ready",
      verifiedAt: new Date().toISOString(),
    });
  }
  setSkillInstallationStatusSync({ installationId: candidate.id, status: "ready", health: "healthy" });
  assert.equal(readActiveArtifactDigestForSkillSync(skill.id), first.digest);

  const promoted = promoteSkillUpgradeSync({
    installationId: candidate.id,
    skillId: skill.id,
    expectedPreviousDigest: first.digest,
  });
  assert.equal(promoted.ok, true);
  assert.equal(readActiveArtifactDigestForSkillSync(skill.id), second.digest);

  assert.throws(
    () => promoteSkillUpgradeSync({
      installationId: candidate.id,
      skillId: skill.id,
      expectedPreviousDigest: first.digest,
    }),
    /concurrently|active digest/i,
  );
});

test("createSkillUpgradePlanSync rejects a cross-runtime upgrade", () => {
  resetWorkspaceStateSync("default");
  const runtimeA = createTestRuntime();
  const runtimeB = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts();
  const v1 = readyInstall(runtimeA, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({ fromDigest: first.digest, toDigest: second.digest, diffHash });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId: runtimeB, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /must stay on the same runtime/,
  );
});

test("createSkillUpgradePlanSync rejects artifacts with no lineage bindings", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const { first, second } = buildUpgradeArtifacts(null);
  const v1 = readyInstall(runtimeId, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({ fromDigest: first.digest, toDigest: second.digest, diffHash });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /bound to a skill lineage/,
  );
});

test("createSkillUpgradePlanSync rejects artifacts bound to different skills", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const firstSkill = createWorkspaceSkillSync({ name: `Lineage A ${cryptoRandomBytes(3).toString("hex")}` });
  const secondSkill = createWorkspaceSkillSync({ name: `Lineage B ${cryptoRandomBytes(3).toString("hex")}` });
  const first = buildUpgradeArtifacts(firstSkill.id).first;
  const second = buildUpgradeArtifacts(secondSkill.id).second;
  const v1 = readyInstall(runtimeId, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({ fromDigest: first.digest, toDigest: second.digest, diffHash });

  assert.throws(
    () => createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id, approvalId }),
    /crosses skill lineage/,
  );
});

test("createSkillUpgradePlanSync queues services newly declared by the candidate artifact", () => {
  resetWorkspaceStateSync("default");
  const runtimeId = createTestRuntime();
  const skill = createWorkspaceSkillSync({ name: `Service Upgrade ${cryptoRandomBytes(3).toString("hex")}` });
  const salt = cryptoRandomBytes(4).toString("hex");
  const first = buildAndPersistSkillArtifactSync({
    skillId: skill.id,
    name: "Service Upgrade",
    files: [{ path: "SKILL.md", bytes: ENCODER.encode(`# v1 ${salt}\n`) }],
  });
  const second = buildAndPersistSkillArtifactSync({
    skillId: skill.id,
    name: "Service Upgrade",
    files: [{ path: "SKILL.md", bytes: ENCODER.encode(`# v2 ${salt}\n`) }],
    services: [{ catalogSlug: "candidate-renderer", templateVersion: "2.0.0", required: true }],
  });
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "candidate-renderer",
    templateVersion: "2.0.0",
    deploymentType: "managed_service",
    imageDigest: sha("d"),
  });
  const v1 = readyInstall(runtimeId, first.digest);
  const diffHash = breakingDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({
    skillId: skill.id,
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash,
  });

  const v2 = createSkillUpgradePlanSync({
    runtimeId,
    artifactDigest: second.digest,
    previousReadyInstallationId: v1.id,
    approvalId,
  });
  const serviceOperations = listManagedSkillServiceOperationsSync({ workspaceId: "default", runtimeId });
  assert.equal(serviceOperations.length, 1);
  assert.equal(serviceOperations[0]?.installationId, v2.id);
  assert.equal(serviceOperations[0]?.operation, "provision");
});

test("a required service without a catalog entry makes the lock unresolved and blocks the plan", () => {
  resetWorkspaceStateSync("default");
  const salt = cryptoRandomBytes(4).toString("hex");
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Needs Service",
    files: [
      { path: "SKILL.md", bytes: ENCODER.encode(`# Body ${salt}\n`) },
      { path: "scripts/render.py", bytes: ENCODER.encode("print('v1')\n"), mode: "0755" },
    ],
    services: [{ catalogSlug: "missing-renderer", templateVersion: "1.0.0", required: true }],
  });

  const lock = computeSkillReleaseLockSync(artifact.artifact, "default");
  assert.deepEqual(lock.unresolvedRequired, ["service:missing-renderer"]);

  // Fail-closed: the installation is blocked at plan time.
  const runtimeId = createTestRuntime();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });
  assert.equal(installation.status, "blocked");
});

test("an optional service without a catalog entry does not block the plan", () => {
  resetWorkspaceStateSync("default");
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Optional Service",
    files: [{ path: "SKILL.md", bytes: ENCODER.encode("# Body\n") }],
    services: [{ catalogSlug: "optional-renderer", templateVersion: "1.0.0", required: false }],
  });

  const lock = computeSkillReleaseLockSync(artifact, "default");
  assert.deepEqual(lock.unresolvedRequired, []);
  const runtimeId = createTestRuntime();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });
  assert.equal(installation.status, "preparing");
});

test("verifySkillInstallationLockReconstructableSync proves reproducibility, and the catalog is immutable", () => {
  resetWorkspaceStateSync("default");
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: sha("img"),
    configSchemaVersion: 3,
  });
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Reconstructable",
    files: [{ path: "SKILL.md", bytes: ENCODER.encode("# Body\n") }],
    services: [{ catalogSlug: "document-renderer", templateVersion: "2.1.0", required: true }],
  });
  const runtimeId = createTestRuntime();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });
  assert.equal(installation.status, "preparing", "required service is pinned, so not blocked");
  assert.equal(verifySkillInstallationLockReconstructableSync(installation.id, "default"), true);

  // Mutating the catalog breaks reconstruction (the lock no longer re-derives).
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: sha("changed"),
    configSchemaVersion: 4,
  });
  // The catalog is immutable per (slug, templateVersion) — first write wins — so
  // the reconstruction still holds; the digest only changes if the catalog row
  // itself were replaced, which the immutability prevents.
  assert.equal(verifySkillInstallationLockReconstructableSync(installation.id, "default"), true);
  assert.equal(readSkillInstallationLockSync(installation.id, "default")?.serviceImageDigests["document-renderer"], sha("img"));
});

test("MCP release locks remain reconstructable after a newer catalog release is published", () => {
  resetWorkspaceStateSync("default");
  const firstRelease = upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug: "github-versioned",
    version: "1.0.0",
    transport: "streamable_http",
    displayName: "GitHub v1",
    declaredToolsJson: JSON.stringify([{ name: "search_issues" }]),
  });
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Pinned MCP Release",
    files: [{ path: "SKILL.md", bytes: ENCODER.encode("# Body\n") }],
    capabilities: [{ kind: "mcp", catalogSlug: "github-versioned", requiredTools: ["search_issues"] }],
  });
  const installation = createSkillInstallationPlanSync({
    runtimeId: createTestRuntime(),
    artifactDigest: artifact.digest,
  });
  const lock = readSkillInstallationLockSync(installation.id, "default");
  assert.deepEqual(lock?.mcpCatalogReleases["github-versioned"], {
    catalogItemId: firstRelease.id,
    version: "1.0.0",
    toolFingerprint: lock?.mcpToolFingerprints["github-versioned"],
  });

  upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug: "github-versioned",
    version: "2.0.0",
    transport: "streamable_http",
    displayName: "GitHub v2",
    declaredToolsJson: JSON.stringify([{ name: "search_issues" }, { name: "create_issue" }]),
  });
  assert.equal(verifySkillInstallationLockReconstructableSync(installation.id, "default"), true);

  const {
    mcpCatalogReleases: _mcpCatalogReleases,
    lockDigest: _lockDigest,
    unresolvedRequired,
    ...legacyFields
  } = lock!;
  const legacyLockDigest = createHash("sha256").update(stableStringify(legacyFields)).digest("hex");
  getDatabase().prepare(
    `UPDATE skill_installation SET resolved_lock_json = ?::jsonb WHERE id = ? AND workspace_id = ?`,
  ).run(JSON.stringify({ ...legacyFields, lockDigest: legacyLockDigest, unresolvedRequired }), installation.id, "default");
  assert.equal(
    verifySkillInstallationLockReconstructableSync(installation.id, "default"),
    true,
    "legacy fingerprint-only locks resolve their original release instead of the latest",
  );

  // A release is immutable. If an administrative upsert violates that contract,
  // reconstruction must detect the changed tool surface instead of accepting it.
  upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug: "github-versioned",
    version: "1.0.0",
    transport: "streamable_http",
    displayName: "GitHub v1 mutated",
    declaredToolsJson: JSON.stringify([{ name: "delete_repository" }]),
  });
  assert.equal(verifySkillInstallationLockReconstructableSync(installation.id, "default"), false);
});
