import assert from "node:assert/strict";
import test from "node:test";
import { computeArtifactDigest, type SkillArtifactManifest } from "./skill-artifacts.ts";

/**
 * Digest contract tests (pure, no DB). Locks the source-independence fix:
 * the artifact digest is a pure function of content, so the same skill imported
 * from a directory, ZIP, Git, or registry mirror collides on one digest — which
 * is what makes re-import idempotent and provenance separate (02-架构设计.md §2).
 */

const baseManifest: SkillArtifactManifest = {
  schemaVersion: 1,
  artifact: { name: "render", version: "1.0.0" },
  files: [
    { path: "SKILL.md", sha256: "a".repeat(64), size: 12, mediaType: "text/markdown", mode: "0644" },
    { path: "scripts/render.py", sha256: "b".repeat(64), size: 42, mediaType: "text/x-python", mode: "0755" },
  ],
  dependencies: [],
};
const fileDigests = baseManifest.files.map((file) => file.sha256).sort();

test("digest is identical regardless of source provenance", () => {
  const fromGithub = computeArtifactDigest(
    { ...baseManifest, source: { type: "github", url: "https://github.com/x/y" } },
    fileDigests,
  );
  const fromLocal = computeArtifactDigest(
    { ...baseManifest, source: { type: "local", url: "/tmp/skill" } },
    fileDigests,
  );
  const fromRegistry = computeArtifactDigest(
    { ...baseManifest, source: { type: "skills.sh", url: "https://skills.sh/x/y/z" } },
    fileDigests,
  );
  const noSource = computeArtifactDigest(baseManifest, fileDigests);

  assert.equal(fromGithub, fromLocal);
  assert.equal(fromGithub, fromRegistry);
  assert.equal(fromGithub, noSource);
});

test("digest is deterministic for identical content", () => {
  const left = computeArtifactDigest(baseManifest, fileDigests);
  const right = computeArtifactDigest(structuredClone(baseManifest), [...fileDigests]);
  assert.equal(left, right);
});

test("digest changes when file content changes", () => {
  const original = computeArtifactDigest(baseManifest, fileDigests);
  const modified = computeArtifactDigest(baseManifest, ["c".repeat(64), ...fileDigests.slice(1)]);
  assert.notEqual(original, modified);
});

test("digest changes when executable mode changes", () => {
  const original = computeArtifactDigest(baseManifest, fileDigests);
  const withExecMode: SkillArtifactManifest = {
    ...baseManifest,
    files: baseManifest.files.map((file) =>
      file.path === "SKILL.md" ? { ...file, mode: "0755" } : file,
    ),
  };
  assert.notEqual(original, computeArtifactDigest(withExecMode, fileDigests));
});

test("digest ignores the human-facing artifact.sha256 placeholder", () => {
  const without = computeArtifactDigest(baseManifest, fileDigests);
  const withPlaceholder = computeArtifactDigest(
    { ...baseManifest, artifact: { ...baseManifest.artifact, sha256: "deadbeef" } as never },
    fileDigests,
  );
  assert.equal(without, withPlaceholder);
});
