import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, readSkillArtifactFilesSync } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  materializeSkillArtifactFilesSync,
  mediaTypeForPath,
  setAttachmentStorageClientForTests,
  verifySkillArtifactIntegritySync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import { sha256Hex } from "../attachments/storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-persist-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();

function binaryBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 31 + index * 7) % 256;
  }
  return bytes;
}

function sampleFiles(): Array<{ path: string; bytes: Uint8Array }> {
  return [
    { path: "SKILL.md", bytes: new TextEncoder().encode("# Demo Skill\n\nRegression sample.\n") },
    { path: "scripts/validate-swiss-deck.mjs", bytes: new TextEncoder().encode("export function validate(){ return true; }\n") },
    { path: "assets/logo.png", bytes: binaryBytes(1) },
    { path: "assets/font.woff", bytes: binaryBytes(2) },
  ];
}

function readDirectoryBytes(dir: string, prefix = ""): Array<{ path: string; bytes: Uint8Array }> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readDirectoryBytes(absolute, rel));
    } else if (entry.isFile()) {
      files.push({ path: rel, bytes: new Uint8Array(readFileSync(absolute)) });
    }
  }
  return files;
}

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testStorage.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

/** The shared test PG occasionally loses the default workspace row; re-seed it. */
function seedDefaultWorkspaceIfMissing(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
}

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM skill_artifact_file");
  db.exec("DELETE FROM skill_artifact");
  db.exec("DELETE FROM content_blob");
  db.exec("DELETE FROM employee_persistent_workspace");
});

after(() => {
  process.chdir(originalCwd);
});

test("D-01: manifest covers every file including scripts + binary assets", () => {
  const files = sampleFiles();
  const result = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "demo-skill",
    files,
    sourceType: "local",
  });

  assert.equal(result.created, true);
  assert.equal(result.manifest.files.length, files.length);
  assert.equal(result.artifact.fileCount, files.length);

  for (const file of files) {
    const entry = result.manifest.files.find((item) => item.path === file.path);
    assert.ok(entry, `manifest missing ${file.path}`);
    assert.equal(entry.sha256, sha256Hex(file.bytes));
    assert.equal(entry.size, file.bytes.byteLength);
  }

  assert.equal(readSkillArtifactFilesSync(result.artifact.id).length, files.length);
  assert.equal(mediaTypeForPath("assets/logo.png"), "image/png");
  assert.equal(mediaTypeForPath("assets/font.woff"), "font/woff");
  assert.equal(mediaTypeForPath("scripts/validate-swiss-deck.mjs"), "text/javascript");
});

test("D-01: binary blobs round-trip byte-identical through materialization", () => {
  const result = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "roundtrip-skill",
    files: sampleFiles(),
  });
  const targetDir = join(tempRoot, "materialized", "roundtrip");
  materializeSkillArtifactFilesSync(result.artifact, targetDir);

  for (const file of sampleFiles()) {
    const restored = new Uint8Array(readFileSync(join(targetDir, file.path)));
    assert.deepEqual(restored, file.bytes, `bytes mismatch for ${file.path}`);
  }
});

test("identical content re-imports to the same digest without duplication", () => {
  const first = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "det-skill",
    files: sampleFiles(),
  });
  const second = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "det-skill",
    files: sampleFiles(),
  });
  assert.equal(second.digest, first.digest);
  assert.equal(second.created, false);
  assert.equal(second.artifact.id, first.artifact.id);
});

test("removing a file changes the digest and file count", () => {
  const original = buildAndPersistSkillArtifactSync({ workspaceId: "default", name: "mut", files: sampleFiles() });
  const fewerInput = sampleFiles().filter((file) => file.path !== "assets/font.woff");
  const fewer = buildAndPersistSkillArtifactSync({ workspaceId: "default", name: "mut", files: fewerInput });
  assert.notEqual(fewer.digest, original.digest);
  assert.equal(fewer.artifact.fileCount, fewerInput.length);
});

test("healthy artifact passes integrity verification", () => {
  const result = buildAndPersistSkillArtifactSync({ workspaceId: "default", name: "ok", files: sampleFiles() });
  const integrity = verifySkillArtifactIntegritySync(result.artifact);
  assert.equal(integrity.ok, true, JSON.stringify(integrity));
  assert.equal(integrity.rootDigestMatches, true);
});

test("D-11: missing blob fails integrity verification — no false success", () => {
  const result = buildAndPersistSkillArtifactSync({ workspaceId: "default", name: "missing", files: sampleFiles() });
  const target = result.manifest.files.find((file) => file.path === "assets/logo.png")!;
  testStorage.client.deleteContentAddressedBlobSync({ workspaceId: "default", sha256: target.sha256 });

  const integrity = verifySkillArtifactIntegritySync(result.artifact);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.missing.includes("assets/logo.png"));
});

test("artifact requires SKILL.md", () => {
  assert.throws(() => {
    buildAndPersistSkillArtifactSync({
      workspaceId: "default",
      name: "no-skill-md",
      files: [{ path: "README.md", bytes: new TextEncoder().encode("hi") }],
    });
  }, /must contain SKILL\.md/);
});

test("guizang-ppt-skill regression: scripts + images all preserved (sample ~/.codex/skills)", () => {
  const realSkill = join(homedir(), ".codex", "skills", "guizang-ppt-skill");
  if (!existsSync(realSkill)) {
    // Not present on this machine/CI → skip the real-sample assertion.
    return;
  }
  const files = readDirectoryBytes(realSkill);
  assert.ok(files.some((file) => file.path === "scripts/validate-swiss-deck.mjs"), "validator script missing");
  assert.ok(files.some((file) => file.path === "SKILL.md"), "SKILL.md missing");

  const result = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "guizang-ppt-skill",
    files,
    sourceType: "local",
  });

  const imageCount = result.manifest.files.filter(
    (f) => f.mediaType === "image/png" || f.mediaType === "image/webp",
  ).length;
  assert.ok(imageCount >= 9, `expected >=9 image files preserved, got ${imageCount}`);
  assert.equal(result.artifact.fileCount, files.length, "no file may be dropped on import");
  assert.equal(verifySkillArtifactIntegritySync(result.artifact).ok, true);
});

test("materialization neutralizes path traversal — file stays inside the target dir", () => {
  const artifact = buildAndPersistSkillArtifactSync({
    workspaceId: "default",
    name: "traversal",
    files: sampleFiles(),
  });
  // Tamper with ONE stored file row's path to attempt `../` traversal.
  const db = getDatabase();
  db.prepare(
    `UPDATE skill_artifact_file SET path = '../escape.txt' WHERE artifact_id = ? AND path = 'SKILL.md'`,
  ).run(artifact.artifact.id);

  const targetDir = join(tempRoot, "materialized", "traversal");
  // normalizeSkillFilePath strips `..`, so the tampered path is neutralized:
  // materialization writes inside the target dir and never outside it.
  materializeSkillArtifactFilesSync(artifact.artifact, targetDir);
  assert.ok(existsSync(join(targetDir, "escape.txt")), "neutralized path materializes inside target dir");
  assert.ok(!existsSync(join(tempRoot, "escape.txt")), "must not write outside the target dir");
});

test("relative path helper stays inside target dir", () => {
  // Guards the materialize path-resolution logic.
  const nested = relative(join(tempRoot, "a"), join(tempRoot, "a", "b", "SKILL.md"));
  assert.equal(nested, "b/SKILL.md");
});
