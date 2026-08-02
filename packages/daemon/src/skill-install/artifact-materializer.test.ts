import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { readSkillArtifactFilesSync } from "@dofe-agent/db";
import { resetWorkspaceStateSync } from "@dofe-agent/services";
import {
  buildAndPersistSkillArtifactSync,
  computeArtifactDigest,
  type SkillArtifactManifest,
} from "@dofe-agent/services";
import {
  materializeSkillInstallationArtifact,
  SkillMaterializationError,
  type MaterializedSkillFile,
} from "./artifact-materializer.ts";

const workspaceId = "default";
const localRoot = mkdtempSync(join(tmpdir(), "dofe-agent-materializer-"));

process.env.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE = "0";
process.env.ATTACHMENT_STORAGE_PROVIDER = "local";
process.env.ATTACHMENT_ENABLE_LOCAL_FALLBACK = "true";
process.env.SELF_HOSTED_ATTACHMENT_LOCAL_ROOT = localRoot;

beforeEach(() => {
  resetWorkspaceStateSync(workspaceId);
});

after(() => {
  rmSync(localRoot, { recursive: true, force: true });
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentBlobStoredPath(sha256: string): string {
  const normalized = sha256.trim().toLowerCase();
  const prefix = normalized.slice(0, 2) || "00";
  return `local:///workspaces/${workspaceId}/content-blobs/${prefix}/${normalized}`;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface TestArtifact {
  digest: string;
  manifestJson: string;
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    mediaType: string;
    mode: string;
  }>;
}

function buildTestArtifact(): TestArtifact {
  const result = buildAndPersistSkillArtifactSync({
    workspaceId,
    name: "test-skill",
    version: "1.0.0",
    files: [
      {
        path: "SKILL.md",
        bytes: encodeText("# Test Skill\n"),
      },
      {
        path: "bin/run.sh",
        bytes: encodeText("#!/bin/sh\necho hello\n"),
      },
    ],
  });

  const manifest: SkillArtifactManifest = JSON.parse(result.artifact.manifestJson);
  const fileRecords = readSkillArtifactFilesSync(result.artifact.id);
  const files = fileRecords.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.sizeBytes,
    mediaType: file.mediaType,
    mode: file.mode,
  }));

  const computedDigest = computeArtifactDigest(
    manifest,
    files
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path, "en-US"))
      .map((file) => file.sha256),
  );
  assert.equal(computedDigest, result.digest);

  return {
    digest: result.digest,
    manifestJson: result.artifact.manifestJson,
    files,
  };
}

function withStoredPaths(artifact: TestArtifact) {
  return artifact.files.map((file) => ({
    ...file,
    storedPath: contentBlobStoredPath(file.sha256),
  }));
}

function findFile(result: { files: MaterializedSkillFile[] }, path: string) {
  return result.files.find((file) => file.path === path);
}

test("materializes a valid artifact from local stored paths with matching root digest", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-"));

  try {
    const result = await materializeSkillInstallationArtifact(
      {
        operationId: "op-1",
        workspaceId,
        runtimeId: "runtime-1",
        installationId: "install-1",
        operation: "prepare",
        artifactDigest: artifact.digest,
        artifactName: "test-skill",
        manifestJson: artifact.manifestJson,
        files: withStoredPaths(artifact),
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
    );

    assert.equal(result.rootDigestMatches, true);
    assert.equal(result.expectedDigest, artifact.digest);
    assert.equal(result.computedDigest, artifact.digest);
    assert.equal(result.files.length, 2);

    const skillMd = findFile(result, "SKILL.md");
    assert.ok(skillMd);
    assert.equal(
      readFileSync(join(targetDir, "SKILL.md"), "utf8"),
      "# Test Skill\n",
    );
    assert.equal(statSync(join(targetDir, "SKILL.md")).mode & 0o777, 0o644);

    const runScript = findFile(result, "bin/run.sh");
    assert.ok(runScript);
    assert.equal(
      readFileSync(join(targetDir, "bin/run.sh"), "utf8"),
      "#!/bin/sh\necho hello\n",
    );
    assert.equal(statSync(join(targetDir, "bin/run.sh")).mode & 0o111, 0o111);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("materializes a file from downloadUrl when storedPath is absent", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-url-"));
  const originalFetch = globalThis.fetch;

  try {
    const skillBytes = encodeText("# Test Skill\n");
    globalThis.fetch = (async () =>
      new Response(Buffer.from(skillBytes), {
        status: 200,
        headers: { "content-type": "text/markdown" },
      })) as typeof fetch;

    const result = await materializeSkillInstallationArtifact(
      {
        operationId: "op-url",
        workspaceId,
        runtimeId: "runtime-1",
        installationId: "install-1",
        operation: "prepare",
        artifactDigest: artifact.digest,
        artifactName: "test-skill",
        manifestJson: artifact.manifestJson,
        files: [
          {
            path: "SKILL.md",
            sha256: sha256Hex(skillBytes),
            size: skillBytes.byteLength,
            mediaType: "text/markdown",
            mode: "0644",
            downloadUrl: "https://example.com/SKILL.md",
          },
        ],
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
    );

    assert.equal(result.rootDigestMatches, false);
    assert.equal(result.files.length, 1);
    assert.equal(
      readFileSync(join(targetDir, "SKILL.md"), "utf8"),
      "# Test Skill\n",
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a file digest does not match the claimed sha256", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-bad-digest-"));

  try {
    const files = withStoredPaths(artifact);
    files[0]!.sha256 = "0".repeat(64);

    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-bad-digest",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: artifact.digest,
            artifactName: "test-skill",
            manifestJson: artifact.manifestJson,
            files,
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
        ),
      (error: unknown) =>
        error instanceof SkillMaterializationError &&
        error.code === "skill_installation.materialization_failed" &&
        /file_digest_mismatch/.test(error.message),
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a file size does not match the claimed size", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-bad-size-"));

  try {
    const files = withStoredPaths(artifact);
    files[0]!.size = 99999;

    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-bad-size",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: artifact.digest,
            artifactName: "test-skill",
            manifestJson: artifact.manifestJson,
            files,
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
        ),
      (error: unknown) =>
        error instanceof SkillMaterializationError &&
        error.code === "skill_installation.materialization_failed" &&
        /file_size_mismatch/.test(error.message),
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws on path traversal attempts", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-traversal-"));

  try {
    const files = withStoredPaths(artifact);
    // Reuse the real blob for SKILL.md but try to write it outside the target directory.
    files.push({
      ...files[0]!,
      path: "../escape.txt",
    });

    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-traversal",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: artifact.digest,
            artifactName: "test-skill",
            manifestJson: artifact.manifestJson,
            files,
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
        ),
      (error: unknown) =>
        error instanceof SkillMaterializationError &&
        error.code === "skill_installation.materialization_failed" &&
        /path_traversal/.test(error.message),
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a referenced local blob is missing", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-missing-blob-"));

  try {
    const files = withStoredPaths(artifact);
    files[0]!.storedPath = contentBlobStoredPath("0".repeat(64));

    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-missing-blob",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: artifact.digest,
            artifactName: "test-skill",
            manifestJson: artifact.manifestJson,
            files,
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
        ),
      (error: unknown) =>
        error instanceof SkillMaterializationError &&
        error.code === "skill_installation.materialization_failed",
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("reports root digest mismatch without throwing away materialized files", async () => {
  const artifact = buildTestArtifact();
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-root-mismatch-"));

  try {
    const result = await materializeSkillInstallationArtifact(
      {
        operationId: "op-root-mismatch",
        workspaceId,
        runtimeId: "runtime-1",
        installationId: "install-1",
        operation: "prepare",
        artifactDigest: "not-the-real-digest",
        artifactName: "test-skill",
        manifestJson: artifact.manifestJson,
        files: withStoredPaths(artifact),
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
    );

    assert.equal(result.rootDigestMatches, false);
    assert.notEqual(result.computedDigest, result.expectedDigest);
    assert.equal(existsSync(join(targetDir, "SKILL.md")), true);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

function existsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
