import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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
  const operation = buildOperation();
  const cachePath = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest: operation.artifactDigest,
  });
  // Pre-seed a completed cache: artifact file + sentinel + digest metadata.
  mkdirSync(join(cachePath, "sub"), { recursive: true });
  writeFileSync(join(cachePath, "SKILL.md"), "abc");
  writeFileSync(join(cachePath, "sub", "nested.txt"), "nested");
  writeFileSync(join(cachePath, ".cache-complete"), new Date().toISOString());
  writeFileSync(
    join(cachePath, ".cache-result.json"),
    JSON.stringify({
      files: [{ path: "SKILL.md", sha256: operation.files[0]!.sha256, size: 3 }],
      computedDigest: operation.artifactDigest,
      expectedDigest: operation.artifactDigest,
    }),
  );

  await executeSkillInstallationOperation(fakeClient, buildConfig(), operation);

  assert.ok(lastComplete, "operation completed");
  assert.equal(lastComplete!.operationId, "op-1");
  const safeResult = JSON.parse(String(lastComplete!.body.safeResultJson)) as Record<string, unknown>;
  assert.equal(safeResult.cacheHit, true);
  assert.equal(safeResult.preparedPath, cachePath);
  assert.equal(safeResult.computedDigest, operation.artifactDigest);

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
      files: [],
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

    // Second run for the same digest must hit the cache.
    await executeSkillInstallationOperation(fakeClient, buildConfig(), { ...operation, operationId: "op-2", installationId: "inst-2" });
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
