import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { getDaemonSkillInstallCachePath, getDaemonSkillInstallWorkDirPath } from "@dofe-agent/db";
import { computeArtifactDigest, type SkillArtifactManifest } from "@dofe-agent/services";
import type { ClaimedSkillInstallationOperation } from "@dofe-agent/domain";
import { executeSkillInstallationOperation } from "./operation-worker.ts";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";

let stateDir: string;
let lastComplete: { operationId: string; body: Record<string, unknown> } | undefined;
let lastFail: { operationId: string; body: Record<string, unknown> } | undefined;

const fakeClient = {
  async startSkillInstallationOperation(_operationId: string): Promise<void> {},
  async completeSkillInstallationOperation(
    operationId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    lastComplete = { operationId, body };
  },
  async failSkillInstallationOperation(operationId: string, body: Record<string, unknown>): Promise<void> {
    lastFail = { operationId, body };
  },
} as unknown as HttpDaemonClient;

function buildConfig(): RemoteDaemonConfig {
  return { stateDir } as unknown as RemoteDaemonConfig;
}

function buildOperation(overrides: Partial<ClaimedSkillInstallationOperation> = {}): ClaimedSkillInstallationOperation {
  return {
    operationId: "op-1",
    claimGeneration: 1,
    workspaceId: "default",
    runtimeId: "runtime-1",
    installationId: "inst-1",
    operation: "prepare",
    artifactDigest: "a".repeat(64),
    artifactName: "test-skill",
    manifestJson: "{}",
    files: [
      { path: "SKILL.md", sha256: "b".repeat(64), size: 3, mediaType: "text/markdown", mode: "0644" },
    ],
    components: [{ kind: "dependency", key: "package:integrity", status: "pending" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-cache-"));
  lastComplete = undefined;
  lastFail = undefined;
});

afterEach(() => {
  // Cleanup is best-effort; the shared tmpdir is fine.
});

test("reuses a pre-warmed digest-keyed cache and reports cacheHit + preparedPath", async () => {
  const skillMdBytes = Buffer.from("abc", "utf8");
  const nestedBytes = Buffer.from("nested", "utf8");
  const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const manifest: SkillArtifactManifest = {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: [
      { path: "SKILL.md", sha256: sha256Of(skillMdBytes), size: skillMdBytes.length, mediaType: "text/markdown", mode: "0644" },
      { path: "sub/nested.txt", sha256: sha256Of(nestedBytes), size: nestedBytes.length, mediaType: "text/plain", mode: "0644" },
    ],
    dependencies: [],
  };
  const manifestJson = JSON.stringify(manifest);
  const sortedDigests = manifest.files.map((file) => file.sha256).sort((a, b) => a.localeCompare(b, "en-US"));
  const artifactDigest = computeArtifactDigest(manifest, sortedDigests);

  const operation = buildOperation({
    artifactDigest,
    manifestJson,
    components: [],
    files: manifest.files.map((file) => ({ ...file, storedPath: "local:///unused" })),
  });
  const cachePath = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest,
  });
  // Pre-seed a completed, content-consistent cache: exact path set + per-file
  // sha256 + manifestJson that re-derives the same root digest.
  mkdirSync(join(cachePath, "sub"), { recursive: true });
  writeFileSync(join(cachePath, "SKILL.md"), skillMdBytes);
  writeFileSync(join(cachePath, "sub", "nested.txt"), nestedBytes);
  writeFileSync(join(cachePath, ".cache-complete"), new Date().toISOString());
  writeFileSync(
    join(cachePath, ".cache-result.json"),
    JSON.stringify({
      files: manifest.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        mediaType: file.mediaType,
        mode: file.mode,
      })),
      computedDigest: artifactDigest,
      expectedDigest: artifactDigest,
      manifestJson,
    }),
  );
  chmodSync(join(cachePath, "SKILL.md"), 0o444);
  chmodSync(join(cachePath, "sub", "nested.txt"), 0o444);
  chmodSync(join(cachePath, ".cache-complete"), 0o444);
  chmodSync(join(cachePath, ".cache-result.json"), 0o444);
  chmodSync(join(cachePath, "sub"), 0o555);
  chmodSync(cachePath, 0o555);

  await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);

  assert.ok(lastComplete, "operation completed");
  assert.equal(lastComplete!.operationId, "op-1");
  const safeResult = JSON.parse(String(lastComplete!.body.safeResultJson)) as Record<string, unknown>;
  assert.equal(safeResult.cacheHit, true);
  assert.equal(safeResult.preparedPath, cachePath);
  assert.equal(safeResult.computedDigest, artifactDigest);

  // Per-operation workDir is cleaned up; the cache survives.
  const workDir = getDaemonSkillInstallWorkDirPath(stateDir, {
    workspaceId: operation.workspaceId,
    installationId: operation.installationId,
    operationId: operation.operationId,
  });
  assert.equal(existsSync(workDir), false, "per-op workDir cleaned up");
  assert.equal(existsSync(join(cachePath, ".cache-complete")), true, "cache survives");
  assert.equal(readFileSync(join(cachePath, "sub", "nested.txt"), "utf8"), "nested");
});

test("materializes on a cache miss, publishes the cache, and the next run hits it", async () => {
  // resolveAttachmentRuntimeConfig() reads cwd's repository overrides; chdir to
  // a bare temp root (with a packages symlink so imports still resolve) so only
  // our process.env values drive local attachment storage.
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-cache-cwd-"));
  const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
  const packagesLink = join(tempRoot, "packages");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  try {
    if (!existsSync(packagesLink)) {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(repositoryRoot, packagesLink, "dir");
    }
    process.chdir(tempRoot);

    // Local attachment storage: the materializer reads `local:///` blobs from
    // the configured local root; the root digest must match the real artifact
    // digest of the downloaded bytes.
    const localRoot = join(tempRoot, "attachments");
    const blobKey = "workspaces/default/content-blobs/bb/bbbb";
    const content = "abc";
    mkdirSync(join(localRoot, "workspaces/default/content-blobs/bb"), { recursive: true });
    writeFileSync(join(localRoot, blobKey), content);
    process.env.ATTACHMENT_STORAGE_PROVIDER = "local";
    process.env.ATTACHMENT_ENABLE_LOCAL_FALLBACK = "true";
    process.env.SELF_HOSTED_ATTACHMENT_LOCAL_ROOT = localRoot;

    const contentSha = createHash("sha256").update(content).digest("hex");
    const manifest: SkillArtifactManifest = {
      schemaVersion: 1,
      artifact: { name: "test-skill", version: "1.0.0" },
      files: [{
        path: "SKILL.md",
        sha256: contentSha,
        size: content.length,
        mediaType: "text/markdown",
        mode: "0644",
      }],
      dependencies: [],
    };
    const manifestJson = JSON.stringify(manifest);
    const artifactDigest = computeArtifactDigest(manifest, [contentSha]);

    const operation = buildOperation({
      operationId: "op-1",
      manifestJson,
      artifactDigest,
      files: [{
        path: "SKILL.md",
        sha256: contentSha,
        size: content.length,
        mediaType: "text/markdown",
        mode: "0644",
        storedPath: `local:///${blobKey}`,
      }],
    });

    await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);
    const firstComplete = lastComplete;
    assert.ok(firstComplete, "first op completed");
    const firstResult = JSON.parse(String(firstComplete.body.safeResultJson)) as Record<string, unknown>;
    assert.equal(firstResult.cacheHit, false);
    const cachePath = getDaemonSkillInstallCachePath(stateDir, {
      workspaceId: operation.workspaceId,
      artifactDigest,
    });
    assert.equal(statSync(cachePath).mode & 0o222, 0, "published cache root is read-only");
    assert.equal(statSync(join(cachePath, "SKILL.md")).mode & 0o222, 0, "published cache files are read-only");
    const publishedMeta = JSON.parse(readFileSync(join(cachePath, ".cache-result.json"), "utf8")) as {
      files: Array<{ path: string; sha256: string; size: number; mode: string }>;
      computedDigest: string;
      expectedDigest: string;
    };
    assert.deepEqual(
      publishedMeta.files.map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode })),
      operation.files.map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode })),
      `published cache evidence diverged from the claim: ${JSON.stringify(publishedMeta)}`,
    );
    assert.equal(publishedMeta.computedDigest, artifactDigest);
    assert.equal(publishedMeta.expectedDigest, artifactDigest);

    // Second run for the same digest must hit the cache.
    await executeSkillInstallationOperation(fakeClient, buildConfig(), { ...operation, operationId: "op-2", installationId: "inst-2" });
    assert.equal(lastFail, undefined, `second operation failed: ${JSON.stringify(lastFail?.body)}`);
    const secondComplete = lastComplete;
    assert.ok(secondComplete, "second op completed");
    const secondResult = JSON.parse(String(secondComplete.body.safeResultJson)) as Record<string, unknown>;
    assert.equal(secondResult.cacheHit, true);
  } finally {
    process.chdir(originalCwd);
    delete process.env.ATTACHMENT_STORAGE_PROVIDER;
    delete process.env.ATTACHMENT_ENABLE_LOCAL_FALLBACK;
    delete process.env.SELF_HOSTED_ATTACHMENT_LOCAL_ROOT;
  }
});

test("rejects a self-consistent cache whose meta and files do not match the current operation", async () => {
  const originalBytes = Buffer.from("original", "utf8");
  const forgedBytes = Buffer.from("forged", "utf8");
  const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const originalManifest: SkillArtifactManifest = {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: [{
      path: "SKILL.md",
      sha256: sha256Of(originalBytes),
      size: originalBytes.length,
      mediaType: "text/markdown",
      mode: "0644",
    }],
    dependencies: [],
  };
  const forgedManifest: SkillArtifactManifest = {
    ...originalManifest,
    files: [{ ...originalManifest.files[0]!, sha256: sha256Of(forgedBytes), size: forgedBytes.length }],
  };
  const artifactDigest = computeArtifactDigest(originalManifest, [sha256Of(originalBytes)]);
  const forgedDigest = computeArtifactDigest(forgedManifest, [sha256Of(forgedBytes)]);
  const operation = buildOperation({
    artifactDigest,
    manifestJson: JSON.stringify(originalManifest),
    components: [],
    files: [{ ...originalManifest.files[0]!, storedPath: "local:///missing" }],
  });
  const cachePath = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest,
  });
  mkdirSync(cachePath, { recursive: true });
  writeFileSync(join(cachePath, "SKILL.md"), forgedBytes);
  writeFileSync(join(cachePath, ".cache-complete"), new Date().toISOString());
  writeFileSync(join(cachePath, ".cache-result.json"), JSON.stringify({
    files: forgedManifest.files,
    computedDigest: forgedDigest,
    expectedDigest: forgedDigest,
    manifestJson: JSON.stringify(forgedManifest),
  }));

  await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);

  assert.equal(lastComplete, undefined, "forged cache is never reported as a hit");
  assert.ok(lastFail, "worker attempts authoritative materialization and fails without a real source");
  assert.equal(existsSync(cachePath), false, "invalid cache entry is removed so a retry can rebuild it");
});

test("a cache-miss materialization that fails verification never publishes the cache", async () => {
  const operation = buildOperation();
  // No blob source at all → the materializer throws before any cache write.
  const cachePath = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest: operation.artifactDigest,
  });

  await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);

  assert.ok(lastFail, "operation failed");
  assert.equal(existsSync(cachePath), false, "no cache published on failure");
  assert.equal(existsSync(join(cachePath, ".cache-complete")), false);
});

test("a verification failure reports component statuses via FAIL (no complete-after-fail)", async () => {
  // Pre-warm a content-consistent cache whose digest matches, so materialization
  // succeeds via cache hit; the component verifier then fails because the
  // declared script `run.sh` is not in the manifest files.
  const skillMdBytes = Buffer.from("abc", "utf8");
  const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const manifest: SkillArtifactManifest = {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: [{
      path: "SKILL.md",
      sha256: sha256Of(skillMdBytes),
      size: skillMdBytes.length,
      mediaType: "text/markdown",
      mode: "0644",
    }],
    dependencies: [],
  };
  const manifestJson = JSON.stringify(manifest);
  const artifactDigest = computeArtifactDigest(manifest, [sha256Of(skillMdBytes)]);
  const operation = buildOperation({
    artifactDigest,
    manifestJson,
    components: [{ kind: "script", key: "run.sh", status: "pending" }],
    files: [{ ...manifest.files[0]!, storedPath: "local:///unused" }],
  });
  const cachePath = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest,
  });
  mkdirSync(cachePath, { recursive: true });
  writeFileSync(join(cachePath, "SKILL.md"), skillMdBytes);
  writeFileSync(join(cachePath, ".cache-complete"), new Date().toISOString());
  writeFileSync(
    join(cachePath, ".cache-result.json"),
    JSON.stringify({
      files: [{
        path: "SKILL.md",
        sha256: sha256Of(skillMdBytes),
        size: skillMdBytes.length,
        mediaType: "text/markdown",
        mode: "0644",
      }],
      computedDigest: artifactDigest,
      expectedDigest: artifactDigest,
      manifestJson,
    }),
  );
  chmodSync(join(cachePath, "SKILL.md"), 0o444);
  chmodSync(join(cachePath, ".cache-complete"), 0o444);
  chmodSync(join(cachePath, ".cache-result.json"), 0o444);
  chmodSync(cachePath, 0o555);

  await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);

  assert.ok(lastFail, "operation failed");
  assert.equal(lastComplete, undefined, "no complete-after-fail");
  const statuses = lastFail!.body.componentStatuses as Array<{ key: string; status: string }> | undefined;
  assert.ok(
    Array.isArray(statuses) && statuses.length > 0,
    `fail carries partial component statuses: ${JSON.stringify(lastFail!.body)}`,
  );
  assert.equal(statuses![0]!.key, "run.sh");
  assert.equal(statuses![0]!.status, "failed");
  assert.equal(lastFail!.body.errorCode, "skill_installation.script_not_in_manifest");
});
