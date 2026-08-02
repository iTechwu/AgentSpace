import assert from "node:assert/strict";
import test from "node:test";
import type { SkillPackageInputFile } from "./package-validator.ts";
import { validateSkillPackage } from "./package-validator.ts";
import { sha256Hex } from "./package-digest.ts";

const encoder = new TextEncoder();

function skillMd(name = "Render Skill", extra = ""): Uint8Array {
  return encoder.encode(`---\nname: ${name}\ndescription: renders\n${extra}---\n# Body\n`);
}

function baseFiles(): SkillPackageInputFile[] {
  return [
    { path: "SKILL.md", bytes: skillMd() },
    { path: "scripts/render.py", bytes: encoder.encode("print('hi')\n"), mode: "0755" },
    { path: "assets/template.docx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) },
  ];
}

test("valid package synthesizes a manifest with sorted files, digests and modes", () => {
  const result = validateSkillPackage({ files: baseFiles() });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.manifest);
  assert.equal(result.manifest!.artifact.name, "Render Skill");
  // Content files sorted by path; manifest.json excluded.
  const paths = result.manifest!.files.map((file) => file.path);
  assert.deepEqual(paths, ["SKILL.md", "assets/template.docx", "scripts/render.py"]);
  const script = result.manifest!.files.find((file) => file.path === "scripts/render.py");
  assert.equal(script?.mode, "0755");
  assert.equal(script?.sha256, sha256Hex(encoder.encode("print('hi')\n")));
});

test("binary asset is preserved and not coerced to UTF-8", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const result = validateSkillPackage({ files: [{ path: "SKILL.md", bytes: skillMd() }, { path: "assets/template.docx", bytes }] });
  assert.equal(result.ok, true);
  const asset = result.files.find((file) => file.path === "assets/template.docx");
  assert.ok(asset);
  assert.equal(asset!.isBinary, true);
  assert.equal(asset!.textContent, undefined);
  // Still recorded in the manifest contract.
  assert.ok(result.manifest!.files.some((file) => file.path === "assets/template.docx"));
  assert.equal(asset!.sha256, sha256Hex(bytes));
});

test("executable mode is preserved on a script", () => {
  const result = validateSkillPackage({ files: [{ path: "SKILL.md", bytes: skillMd() }, { path: "run.sh", bytes: encoder.encode("#!/bin/sh\necho hi\n"), mode: "0755" }] });
  const script = result.files.find((file) => file.path === "run.sh");
  assert.equal(script?.mode, "0755");
});

test("rejects a package missing SKILL.md", () => {
  const result = validateSkillPackage({ files: [{ path: "scripts/render.py", bytes: encoder.encode("print('x')") }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "SKILL_MD_MISSING"));
});

test("rejects path traversal entries", () => {
  const result = validateSkillPackage({ files: [{ path: "SKILL.md", bytes: skillMd() }, { path: "../etc/passwd", bytes: encoder.encode("x") }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "PATH_TRAVERSAL"));
});

test("rejects duplicate paths", () => {
  const result = validateSkillPackage({
    files: [
      { path: "SKILL.md", bytes: skillMd() },
      { path: "scripts/render.py", bytes: encoder.encode("a") },
      { path: "scripts/render.py", bytes: encoder.encode("b") },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "DUPLICATE_PATH"));
});

test("rejects a file exceeding the single-file size limit", () => {
  const huge = new Uint8Array(9 * 1024 * 1024);
  const result = validateSkillPackage({ files: [{ path: "SKILL.md", bytes: skillMd() }, { path: "big.bin", bytes: huge }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "ARCHIVE_TOO_LARGE"));
});

test("rejects too many files", () => {
  const files: SkillPackageInputFile[] = [{ path: "SKILL.md", bytes: skillMd() }];
  for (let index = 0; index < 210; index += 1) {
    files.push({ path: `f${index}.md`, bytes: encoder.encode("x") });
  }
  const result = validateSkillPackage({ files });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "MAX_FILES_EXCEEDED"));
});

test("rejects an empty package", () => {
  const result = validateSkillPackage({ files: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "EMPTY_PACKAGE"));
});

test("rejects SKILL.md frontmatter without a name", () => {
  const result = validateSkillPackage({ files: [{ path: "SKILL.md", bytes: encoder.encode("---\ndescription: nope\n---\nbody\n") }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "FRONTMATTER_INVALID"));
});

test("rejects a submitted manifest whose declared digest does not match content", () => {
  const realBytes = encoder.encode("print('hi')\n");
  const submittedManifest = {
    schemaVersion: 1,
    artifact: { name: "Render Skill", version: "" },
    files: [
      { path: "SKILL.md", sha256: "a".repeat(64), size: 1, mediaType: "text/markdown" },
      { path: "scripts/render.py", sha256: "b".repeat(64), size: 1, mediaType: "text/x-python" },
    ],
  };
  const result = validateSkillPackage({
    files: [{ path: "SKILL.md", bytes: skillMd() }, { path: "scripts/render.py", bytes: realBytes }],
    manifest: submittedManifest,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "DIGEST_MISMATCH"));
});

test("preserves capabilities, services and entrypoints from a submitted manifest", () => {
  const skillMdBytes = skillMd();
  const scriptBytes = encoder.encode("print('hi')\n");
  const submittedManifest = {
    schemaVersion: 1,
    artifact: { name: "Render Skill", version: "1.0.0" },
    files: [
      { path: "SKILL.md", sha256: sha256Hex(skillMdBytes), size: skillMdBytes.byteLength, mediaType: "text/markdown" },
      { path: "scripts/render.py", sha256: sha256Hex(scriptBytes), size: scriptBytes.byteLength, mediaType: "text/x-python", mode: "0755" },
    ],
    capabilities: [{ kind: "mcp" as const, catalogSlug: "render", requiredTools: ["render"] }],
    services: [{ catalogSlug: "postgres", templateVersion: "1.0.0", required: true }],
    entrypoints: [{ id: "render", kind: "script" as const, path: "scripts/render.py", runtime: "python" as const }],
  };
  const result = validateSkillPackage({
    files: baseFiles(),
    manifest: submittedManifest,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest!.capabilities, submittedManifest.capabilities);
  assert.deepEqual(result.manifest!.services, submittedManifest.services);
  assert.deepEqual(result.manifest!.entrypoints, submittedManifest.entrypoints);
  // Computed fields still come from content, not submission.
  assert.equal(result.manifest!.artifact.version, "");
});

test("rejects an invalid JSON .dofe/manifest.json", () => {
  const result = validateSkillPackage({
    files: [
      { path: "SKILL.md", bytes: skillMd() },
      { path: ".dofe/manifest.json", bytes: encoder.encode("{ not json") },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "MANIFEST_INVALID"));
});

test("rejects a declared file that is missing from the package", () => {
  const submittedManifest = {
    schemaVersion: 1,
    artifact: { name: "Render Skill", version: "" },
    files: [
      { path: "SKILL.md", sha256: sha256Hex(skillMd()), size: skillMd().byteLength, mediaType: "text/markdown" },
      { path: "missing.py", sha256: "a".repeat(64), size: 1, mediaType: "text/x-python" },
    ],
  };
  const result = validateSkillPackage({
    files: [{ path: "SKILL.md", bytes: skillMd() }],
    manifest: submittedManifest,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "MANIFEST_INVALID" && error.message.includes("missing.py")));
});

test("rejects undeclared symlinks", () => {
  const result = validateSkillPackage({
    files: [
      { path: "SKILL.md", bytes: skillMd() },
      { path: "scripts/run.sh", bytes: encoder.encode("#!/bin/sh\n"), symlinkTarget: "../etc/passwd" },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "UNDECLARED_SYMLINK"));
});
