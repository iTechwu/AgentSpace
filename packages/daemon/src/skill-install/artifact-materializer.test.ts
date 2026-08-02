import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import {
  buildContentAddressedBlobKey,
  computeArtifactDigest,
  type AttachmentRuntimeConfig,
  type SkillArtifactManifest,
} from "@dofe-agent/services";
import {
  materializeSkillInstallationArtifact,
  SkillMaterializationError,
  type MaterializedSkillFile,
} from "./artifact-materializer.ts";

process.env.NODE_ENV = "test";

const workspaceId = "ws-materializer-test";

interface TestFile {
  path: string;
  bytes: Uint8Array;
  mode: string;
  mediaType: string;
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
    storedPath: string;
  }>;
}

let storageRoot: string;
let localConfig: AttachmentRuntimeConfig;

before(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "dofe-agent-materializer-"));
  localConfig = { provider: "local", local: { root: storageRoot } };
});

after(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Writes each file as a content-addressed blob into the local storage root. */
function writeBlobs(files: TestFile[]): TestArtifact {
  const manifestFiles = files
    .map((file) => {
      const sha256 = sha256Hex(file.bytes);
      return {
        path: file.path,
        sha256,
        size: file.bytes.byteLength,
        mediaType: file.mediaType,
        mode: file.mode,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en-US"));

  // Persist each blob at the same key the runtime local client uses.
  for (const file of files) {
    const sha256 = sha256Hex(file.bytes);
    const key = buildContentAddressedBlobKey(workspaceId, sha256);
    const targetPath = join(storageRoot, key);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.bytes);
  }

  const manifest: SkillArtifactManifest = {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: manifestFiles,
    dependencies: [],
  };
  const digest = computeArtifactDigest(manifest, manifestFiles.map((file) => file.sha256));

  return {
    digest,
    manifestJson: JSON.stringify(manifest),
    files: manifestFiles.map((file) => {
      const key = buildContentAddressedBlobKey(workspaceId, file.sha256);
      return { ...file, storedPath: `local:///${key}` };
    }),
  };
}

function findFile(result: { files: MaterializedSkillFile[] }, path: string) {
  return result.files.find((file) => file.path === path);
}

function existsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

test("materializes a valid artifact from local stored paths with matching root digest", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
    { path: "bin/run.sh", bytes: encodeText("#!/bin/sh\necho hello\n"), mode: "0755", mediaType: "text/x-shellscript" },
  ]);
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
        files: artifact.files,
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
      { resolveAttachmentRuntimeConfig: () => localConfig },
    );

    assert.equal(result.rootDigestMatches, true);
    assert.equal(result.expectedDigest, artifact.digest);
    assert.equal(result.computedDigest, artifact.digest);
    assert.equal(result.files.length, 2);

    assert.equal(readFileSync(join(targetDir, "SKILL.md"), "utf8"), "# Test Skill\n");
    assert.equal(statSync(join(targetDir, "SKILL.md")).mode & 0o777, 0o644);

    assert.equal(readFileSync(join(targetDir, "bin/run.sh"), "utf8"), "#!/bin/sh\necho hello\n");
    assert.equal(statSync(join(targetDir, "bin/run.sh")).mode & 0o111, 0o111);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("materializes nested directory structures", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Skill\n"), mode: "0644", mediaType: "text/markdown" },
    { path: "references/deep/guide.md", bytes: encodeText("Guide\n"), mode: "0644", mediaType: "text/markdown" },
  ]);
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-nested-"));

  try {
    const result = await materializeSkillInstallationArtifact(
      {
        operationId: "op-nested",
        workspaceId,
        runtimeId: "runtime-1",
        installationId: "install-1",
        operation: "prepare",
        artifactDigest: artifact.digest,
        artifactName: "test-skill",
        manifestJson: artifact.manifestJson,
        files: artifact.files,
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
      { resolveAttachmentRuntimeConfig: () => localConfig },
    );

    assert.equal(result.rootDigestMatches, true);
    assert.equal(existsSync(join(targetDir, "references/deep/guide.md")), true);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("materializes a file from downloadUrl when storedPath is absent", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
  ]);
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
      { resolveAttachmentRuntimeConfig: () => localConfig },
    );

    assert.equal(result.rootDigestMatches, true);
    assert.equal(result.files.length, 1);
    assert.equal(readFileSync(join(targetDir, "SKILL.md"), "utf8"), "# Test Skill\n");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a file digest does not match the claimed sha256", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
    { path: "bin/run.sh", bytes: encodeText("#!/bin/sh\necho hello\n"), mode: "0755", mediaType: "text/x-shellscript" },
  ]);
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-bad-digest-"));

  try {
    const files = artifact.files.map((file) => ({ ...file }));
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
          { resolveAttachmentRuntimeConfig: () => localConfig },
        ),
      /digest mismatch/,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a file size does not match the claimed size", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
    { path: "bin/run.sh", bytes: encodeText("#!/bin/sh\necho hello\n"), mode: "0755", mediaType: "text/x-shellscript" },
  ]);
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-bad-size-"));

  try {
    const files = artifact.files.map((file) => ({ ...file }));
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
          { resolveAttachmentRuntimeConfig: () => localConfig },
        ),
      /size mismatch/,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws on path traversal attempts", async () => {
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
  ]);
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-traversal-"));

  try {
    const files = [
      ...artifact.files,
      // Reuse the SKILL.md blob but target a path outside the target directory.
      { ...artifact.files[0]!, path: "../escape.txt" },
    ];

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
          { resolveAttachmentRuntimeConfig: () => localConfig },
        ),
      /escapes target directory/,
    );
    assert.equal(existsSync(join(targetDir, "..", "escape.txt")), false);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a referenced local blob is missing", async () => {
  const manifest: SkillArtifactManifest = {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: [
      {
        path: "SKILL.md",
        sha256: "0".repeat(64),
        size: 1,
        mediaType: "text/markdown",
        mode: "0644",
      },
    ],
    dependencies: [],
  };
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-missing-blob-"));

  try {
    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-missing-blob",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: "irrelevant",
            artifactName: "test-skill",
            manifestJson: JSON.stringify(manifest),
            files: [
              {
                path: "SKILL.md",
                sha256: "0".repeat(64),
                size: 1,
                mediaType: "text/markdown",
                mode: "0644",
                storedPath: `local:///${buildContentAddressedBlobKey(workspaceId, "0".repeat(64))}`,
              },
            ],
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
          { resolveAttachmentRuntimeConfig: () => localConfig },
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
  const artifact = writeBlobs([
    { path: "SKILL.md", bytes: encodeText("# Test Skill\n"), mode: "0644", mediaType: "text/markdown" },
    { path: "bin/run.sh", bytes: encodeText("#!/bin/sh\necho hello\n"), mode: "0755", mediaType: "text/x-shellscript" },
  ]);
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
        files: artifact.files,
        components: [],
        createdAt: new Date().toISOString(),
      },
      targetDir,
      { resolveAttachmentRuntimeConfig: () => localConfig },
    );

    assert.equal(result.rootDigestMatches, false);
    assert.notEqual(result.computedDigest, result.expectedDigest);
    assert.equal(existsSync(join(targetDir, "SKILL.md")), true);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when storedPath points outside the configured attachment root", async () => {
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-escape-root-"));

  try {
    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-escape-root",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: "irrelevant",
            artifactName: "test-skill",
            manifestJson: JSON.stringify({
              schemaVersion: 1,
              artifact: { name: "test-skill", version: "1.0.0" },
              files: [],
              dependencies: [],
            }),
            files: [
              {
                path: "SKILL.md",
                sha256: "0".repeat(64),
                size: 1,
                mediaType: "text/markdown",
                mode: "0644",
                storedPath: "local:///../../../etc/passwd",
              },
            ],
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
          { resolveAttachmentRuntimeConfig: () => localConfig },
        ),
      /escapes the configured attachment root/,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("throws when a file has no downloadUrl or usable storedPath", async () => {
  const targetDir = mkdtempSync(join(tmpdir(), "dofe-agent-materialize-no-source-"));

  try {
    await assert.rejects(
      () =>
        materializeSkillInstallationArtifact(
          {
            operationId: "op-no-source",
            workspaceId,
            runtimeId: "runtime-1",
            installationId: "install-1",
            operation: "prepare",
            artifactDigest: "irrelevant",
            artifactName: "test-skill",
            manifestJson: JSON.stringify({
              schemaVersion: 1,
              artifact: { name: "test-skill", version: "1.0.0" },
              files: [],
              dependencies: [],
            }),
            files: [
              {
                path: "SKILL.md",
                sha256: "0".repeat(64),
                size: 1,
                mediaType: "text/markdown",
                mode: "0644",
                storedPath: "tos://bucket/key",
              },
            ],
            components: [],
            createdAt: new Date().toISOString(),
          },
          targetDir,
          { resolveAttachmentRuntimeConfig: () => localConfig },
        ),
      /cannot be fetched from TOS without credentials/,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("findFile helper returns the matching materialized file", () => {
  const files: MaterializedSkillFile[] = [
    { path: "a.md", sha256: "a", size: 1 },
    { path: "b.md", sha256: "b", size: 2 },
  ];
  assert.equal(findFile({ files }, "b.md")?.sha256, "b");
  assert.equal(findFile({ files }, "missing"), undefined);
});
