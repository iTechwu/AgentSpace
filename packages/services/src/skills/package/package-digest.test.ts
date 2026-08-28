import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { SkillPackageInputFile } from "./package-validator.ts";
import { validateSkillPackage } from "./package-validator.ts";
import { computeArtifactDigest } from "./package-digest.ts";

/**
 * Phase 0 completion gate (06-实施计划.md §3.4):
 * the SAME logical skill, ingested from a directory, a ZIP, and a Git tree,
 * must produce an identical artifact digest. Provenance is excluded from the
 * digest, so source metadata never perturbs it.
 */

const encoder = new TextEncoder();

function fixtureFiles(): SkillPackageInputFile[] {
  return [
    {
      path: "SKILL.md",
      bytes: encoder.encode("---\nname: Parity Skill\ndescription: gate\nversion: 1.0.0\ndependencies:\n  - npm:example@1.4.2\n---\n# Body\n"),
    },
    {
      path: "scripts/render.py",
      bytes: encoder.encode("#!/usr/bin/env python3\nprint('render')\n"),
      mode: "0755",
    },
    {
      path: "assets/template.docx",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0x00]),
    },
  ];
}

/** Simulate a directory read: files in their natural order. */
function directoryReader(files: SkillPackageInputFile[]): SkillPackageInputFile[] {
  return files;
}

/** Simulate a Git tree resolve: same bytes, but enumerated in a different order. */
function gitReader(files: SkillPackageInputFile[]): SkillPackageInputFile[] {
  return [...files].reverse();
}

/** Simulate a ZIP round-trip: bytes survive a real zip/unzip cycle. */
function zipReader(files: SkillPackageInputFile[]): SkillPackageInputFile[] {
  const archive: Record<string, Uint8Array> = {};
  for (const file of files) {
    archive[file.path] = file.bytes;
  }
  const zipped = zipSync(archive);
  const extracted = unzipSync(zipped);
  return Object.entries(extracted).map(([path, bytes]) => {
    const original = files.find((file) => file.path === path);
    return { path, bytes, mode: original?.mode };
  });
}

function digestFor(files: SkillPackageInputFile[]): string {
  const result = validateSkillPackage({ files });
  assert.equal(result.ok, true, `package should validate: ${JSON.stringify(result.errors)}`);
  assert.ok(result.manifest, "manifest should be synthesized");
  return computeArtifactDigest(result.manifest!);
}

test("directory, ZIP, and Git sources yield the same artifact digest", () => {
  const base = fixtureFiles();
  const fromDirectory = digestFor(directoryReader(base));
  const fromZip = digestFor(zipReader(base));
  const fromGit = digestFor(gitReader(base));

  assert.equal(fromDirectory, fromZip);
  assert.equal(fromDirectory, fromGit);
});

test("input order does not affect the digest", () => {
  const base = fixtureFiles();
  assert.equal(digestFor(base), digestFor([...base].reverse()));
});

test("the digest is prefixed with sha256:", () => {
  const digest = digestFor(fixtureFiles());
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
});

test("changing a single byte changes the digest", () => {
  const base = fixtureFiles();
  const original = digestFor(base);
  const modified: SkillPackageInputFile[] = base.map((file) =>
    file.path === "scripts/render.py"
      ? { ...file, bytes: encoder.encode("#!/usr/bin/env python3\nprint('rendered')\n") }
      : file,
  );
  assert.notEqual(original, digestFor(modified));
});

test("changing an executable mode changes the digest", () => {
  const base = fixtureFiles();
  const original = digestFor(base);
  const noExec: SkillPackageInputFile[] = base.map((file) =>
    file.path === "scripts/render.py" ? { ...file, mode: "0644" } : file,
  );
  assert.notEqual(original, digestFor(noExec));
});

test("strToU8 sanity for fixture parity", () => {
  // Confirms fflate's strToU8 matches TextEncoder bytes (used by the legacy
  // import path), so a zip built with strToU8 still digests identically.
  const text = "print('render')\n";
  assert.deepEqual(strToU8(text), encoder.encode(text));
});
