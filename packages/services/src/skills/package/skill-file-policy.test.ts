import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySkillFile,
  inferSkillMediaType,
  isImportableSkillTextFile,
  isLikelyBinaryBytes,
  normalizeSkillFileMode,
  skillFileExtension,
} from "./skill-file-policy.ts";

const encoder = new TextEncoder();

test("policy allows .mjs and .html (previously inconsistent across services/daemon)", () => {
  assert.equal(isImportableSkillTextFile("scripts/run.mjs"), true);
  assert.equal(isImportableSkillTextFile("assets/page.html"), true);
  assert.equal(isImportableSkillTextFile("SKILL.md"), true);
  assert.equal(isImportableSkillTextFile("assets/binary.bin"), false);
});

test("skillFileExtension handles dotfiles and nested paths", () => {
  assert.equal(skillFileExtension("scripts/render.py"), ".py");
  assert.equal(skillFileExtension("SKILL.md"), ".md");
  assert.equal(skillFileExtension("noext"), "");
  // Dotfiles: the leading dot is treated as part of the name's only segment,
  // so `.gitignore` yields `.gitignore` (matches legacy lastIndexOf behavior
  // and correctly excludes it from the text allow-list).
  assert.equal(skillFileExtension(".gitignore"), ".gitignore");
});

test("isLikelyBinaryBytes detects a NUL byte as binary", () => {
  assert.equal(isLikelyBinaryBytes(encoder.encode("hello world")), false);
  assert.equal(isLikelyBinaryBytes(new Uint8Array([0x68, 0x00, 0x69])), true);
});

test("isLikelyBinaryBytes detects invalid UTF-8 as binary", () => {
  assert.equal(isLikelyBinaryBytes(new Uint8Array([0xff, 0xfe, 0xfd])), true);
});

test("classifySkillFile suggests 0755 for scripts and infers media type", () => {
  const result = classifySkillFile("scripts/render.py", encoder.encode("print('x')"));
  assert.equal(result.mediaType, "text/x-python");
  assert.equal(result.suggestedMode, "0755");
  assert.equal(result.isBinary, false);
  assert.equal(result.inlineableText, true);
});

test("classifySkillFile marks a binary asset as non-inlineable", () => {
  const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const result = classifySkillFile("assets/template.docx", binary);
  assert.equal(result.isBinary, true);
  assert.equal(result.inlineableText, false);
  assert.equal(result.mediaType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(result.suggestedMode, "0644");
});

test("inferSkillMediaType maps known extensions", () => {
  assert.equal(inferSkillMediaType("a.json"), "application/json");
  assert.equal(inferSkillMediaType("a.yaml"), "application/yaml");
  assert.equal(inferSkillMediaType("a.unknownext"), "application/octet-stream");
});

test("normalizeSkillFileMode pads and cleans modes", () => {
  assert.equal(normalizeSkillFileMode("755"), "0755");
  assert.equal(normalizeSkillFileMode("0o644"), "0644");
  assert.equal(normalizeSkillFileMode(undefined), "0644");
  assert.equal(normalizeSkillFileMode("garbage"), "0644");
  assert.equal(normalizeSkillFileMode("01234"), "1234");
});
