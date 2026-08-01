import assert from "node:assert/strict";
import test from "node:test";
import { classifySkillFilePath, skillPathDepth } from "./path-safety.ts";

test("normalizes a clean relative path and strips dot segments", () => {
  const result = classifySkillFilePath("./scripts/./render.py");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.normalized, "scripts/render.py");
    assert.equal(result.depth, 2);
  }
});

test("rejects parent-directory traversal", () => {
  const result = classifySkillFilePath("../etc/passwd");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PATH_TRAVERSAL");
  }
});

test("rejects traversal hidden inside a deeper path", () => {
  const result = classifySkillFilePath("scripts/../../etc/passwd");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PATH_TRAVERSAL");
  }
});

test("rejects POSIX absolute paths", () => {
  const result = classifySkillFilePath("/etc/passwd");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "ABSOLUTE_PATH");
  }
});

test("rejects Windows drive-letter paths", () => {
  const result = classifySkillFilePath("C:/Users/x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "ABSOLUTE_PATH");
  }
});

test("normalizes backslashes then rejects traversal", () => {
  const result = classifySkillFilePath("..\\..\\windows\\system32");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PATH_TRAVERSAL");
  }
});

test("rejects empty or whitespace paths", () => {
  assert.equal(classifySkillFilePath("").ok, false);
  assert.equal(classifySkillFilePath("   ").ok, false);
});

test("skillPathDepth counts root file as depth 1", () => {
  assert.equal(skillPathDepth("SKILL.md"), 1);
  assert.equal(skillPathDepth("scripts/render.py"), 2);
});
