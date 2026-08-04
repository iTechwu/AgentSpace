import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillMarkdown } from "../skills/package/skill-md.ts";
import { resolveSkillMdContent } from "./skill-sync.ts";

const baseInput = {
  skillMd: "https://example.invalid/SKILL.md",
  skillName: "clihub-minimax-cli",
  description: "MiniMax CLI usage",
  displayName: "MiniMax CLI",
  entryPoint: "minimax",
};

test("resolveSkillMdContent preserves a valid remote Agent Skill", async () => {
  const remote = "---\nname: minimax-cli\ndescription: Test\n---\n\n# MiniMax\n";
  const result = await resolveSkillMdContent({
    ...baseInput,
    fetchImpl: async () => new Response(remote, { status: 200 }),
  });

  assert.equal(result.content, remote);
  assert.equal(result.warning, undefined);
});

test("resolveSkillMdContent replaces HTML with a valid minimal runtime app skill", async () => {
  const result = await resolveSkillMdContent({
    ...baseInput,
    fetchImpl: async () => new Response("<!DOCTYPE html><html><body>Docs</body></html>", { status: 200 }),
  });

  const parsed = parseSkillMarkdown(result.content);
  assert.equal(parsed.ok, true);
  assert.match(result.content, /`minimax --help`/);
  assert.doesNotMatch(result.content, /<!DOCTYPE html>/);
  assert.match(result.warning ?? "", /未返回有效/);
});

test("resolveSkillMdContent degrades safely when the remote source is unavailable", async () => {
  const result = await resolveSkillMdContent({
    ...baseInput,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  assert.equal(parseSkillMarkdown(result.content).ok, true);
  assert.match(result.content, /`minimax --help`/);
  assert.match(result.warning ?? "", /暂不可用/);
});
