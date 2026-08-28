import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import {
  createWorkspaceSkillSync,
  exportWorkspaceSkillsArchiveSync,
  resetWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-export-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

after(() => {
  process.chdir(originalCwd);
});

test("exportWorkspaceSkillsArchiveSync packages selected skills and a manifest", () => {
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
    sourceType: "github",
    sourceUrl: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });

  const archive = exportWorkspaceSkillsArchiveSync({
    skillIds: [skill.id],
  });

  assert.match(archive.fileName, /research-pack\.zip$/);
  const files = unzipSync(archive.zipBytes);
  const skillDir = `research-pack-${skill.id.slice(-6)}`;
  assert.equal(Boolean(files[`${skillDir}/SKILL.md`]), true);
  assert.equal(Boolean(files[`${skillDir}/skill.json`]), true);
  assert.equal(Boolean(files["skills-manifest.json"]), true);

  const manifest = JSON.parse(strFromU8(files["skills-manifest.json"]));
  assert.equal(manifest.skillCount, 1);
  assert.equal(manifest.skills[0]?.id, skill.id);
});
