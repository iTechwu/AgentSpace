import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  createWorkspaceSkillSync,
  discardSkillDraftSync,
  hasSkillDraftSync,
  listWorkspaceSkillsSync,
  publishSkillDraftSync,
  readSkillDraftSync,
  resetWorkspaceStateSync,
  saveSkillDraftSync,
} from "../index.ts";

beforeEach(() => {
  resetWorkspaceStateSync();
});

test("saving a draft does not touch the live skill and reads back", () => {
  const skill = createWorkspaceSkillSync({ name: "draft-base", description: "v1" });
  const saved = saveSkillDraftSync({
    workspaceId: "default",
    skillId: skill.id,
    name: "draft-new-name",
    description: "v2 draft",
    files: [
      { path: "SKILL.md", content: "---\nname: draft-new-name\n---\n# Draft\n" },
      { path: "notes.md", content: "draft note" },
    ],
  });
  assert.equal(saved.name, "draft-new-name");

  // The live skill is unchanged.
  assert.equal(listWorkspaceSkillsSync().find((item) => item.id === skill.id)?.name, "draft-base");
  assert.equal(hasSkillDraftSync({ workspaceId: "default", skillId: skill.id }), true);
  assert.equal(readSkillDraftSync({ workspaceId: "default", skillId: skill.id })?.description, "v2 draft");
});

test("publishing applies the draft and clears it", () => {
  const skill = createWorkspaceSkillSync({ name: "publish-base", description: "v1" });
  saveSkillDraftSync({
    workspaceId: "default",
    skillId: skill.id,
    name: "publish-v2",
    description: "published description",
    files: [
      { path: "SKILL.md", content: "---\nname: publish-v2\n---\n# V2\n" },
      { path: "extra.md", content: "extra file" },
    ],
  });
  publishSkillDraftSync({ workspaceId: "default", skillId: skill.id });

  const published = listWorkspaceSkillsSync().find((item) => item.id === skill.id);
  assert.equal(published?.name, "publish-v2");
  assert.equal(published?.description, "published description");
  assert.equal(published?.files.some((file) => file.path === "extra.md"), true);
  assert.equal(hasSkillDraftSync({ workspaceId: "default", skillId: skill.id }), false);
});

test("discarding a draft removes it without touching the live skill", () => {
  const skill = createWorkspaceSkillSync({ name: "discard-base" });
  saveSkillDraftSync({
    workspaceId: "default",
    skillId: skill.id,
    name: "discard-draft",
    files: [{ path: "SKILL.md", content: "# Draft\n" }],
  });
  assert.equal(discardSkillDraftSync({ workspaceId: "default", skillId: skill.id }), true);
  assert.equal(hasSkillDraftSync({ workspaceId: "default", skillId: skill.id }), false);
  assert.equal(listWorkspaceSkillsSync().find((item) => item.id === skill.id)?.name, "discard-base");
});

test("publishing without a draft throws and a draft without SKILL.md is rejected", () => {
  const skill = createWorkspaceSkillSync({ name: "err-base" });
  assert.throws(
    () => publishSkillDraftSync({ workspaceId: "default", skillId: skill.id }),
    /没有可发布的草稿/,
  );
  assert.throws(
    () =>
      saveSkillDraftSync({
        workspaceId: "default",
        skillId: skill.id,
        name: "no-skillmd",
        files: [{ path: "readme.md", content: "# no skill md" }],
      }),
    /Skill draft must contain SKILL\.md/,
  );
});
