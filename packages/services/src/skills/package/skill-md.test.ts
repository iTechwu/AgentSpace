import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillMarkdown, readFrontmatterString } from "./skill-md.ts";

test("parseSkillMarkdown parses name and description and preserves unknown fields", () => {
  const markdown = [
    "---",
    "name: Render Skill",
    "description: Renders documents",
    "version: 1.2.0",
    "author: someone",
    "custom:",
    "  nested: value",
    "---",
    "# Body",
    "Instructions here.",
  ].join("\n");

  const result = parseSkillMarkdown(markdown);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.frontmatter.name, "Render Skill");
  assert.equal(result.frontmatter.description, "Renders documents");
  assert.equal(result.frontmatter.body, "# Body\nInstructions here.");
  // Unknown fields preserved verbatim.
  assert.equal(result.frontmatter.raw.version, "1.2.0");
  assert.equal(result.frontmatter.raw.author, "someone");
  assert.deepEqual(result.frontmatter.raw.custom, { nested: "value" });
  assert.equal(readFrontmatterString(result.frontmatter.raw, "version"), "1.2.0");
});

test("parseSkillMarkdown keeps block-scalar descriptions", () => {
  const markdown = "---\nname: x\ndescription: |-\n  line one\n  line two\n---\nbody\n";
  const result = parseSkillMarkdown(markdown);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.frontmatter.description, "line one\nline two");
  }
});

test("parseSkillMarkdown rejects missing frontmatter", () => {
  const result = parseSkillMarkdown("# Just a heading, no frontmatter");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "FRONTMATTER_INVALID");
  }
});

test("parseSkillMarkdown rejects frontmatter without a name", () => {
  const result = parseSkillMarkdown("---\ndescription: no name here\n---\nbody\n");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "FRONTMATTER_INVALID");
    assert.match(result.message, /name/);
  }
});

test("parseSkillMarkdown rejects malformed YAML", () => {
  const result = parseSkillMarkdown("---\nname: [unterminated\n---\nbody\n");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "FRONTMATTER_INVALID");
  }
});

test("parseSkillMarkdown rejects empty SKILL.md", () => {
  const result = parseSkillMarkdown("   ");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SKILL_MD_MISSING");
  }
});
