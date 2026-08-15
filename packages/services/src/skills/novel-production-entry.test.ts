import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  planSkillRollout,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { parseSkillSkillDependencies } from "./dependencies.ts";
import { NOVEL_PRODUCTION_COORDINATES, NOVEL_PRODUCTION_ENTRY_SKILL_MD } from "./novel-production-entry.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testTosStorage = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  testTosStorage.clear();
});

function createRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`
  ).run(id, `Runtime ${id}`, now, now);
  return id;
}

function buildArtifact(input: {
  name: string;
  version?: string;
  coordinate?: string;
  skillDependencies?: Array<{ coordinate: string; version: string; placement: "same_runtime" | "workflow"; required: boolean }>;
}) {
  return buildAndPersistSkillArtifactSync({
    name: input.name,
    version: input.version ?? "1.0.0",
    files: [{ path: "SKILL.md", bytes: encoder.encode(`---\nname: ${input.name}\n---\n# Body\n`) }],
    sourceType: "github",
    sourceUrl: "https://github.com/eternityspring/shuohao-skills",
    coordinate: input.coordinate,
    ...(input.skillDependencies ? { skillDependencies: input.skillDependencies } : {}),
  });
}

test("novel-production entry skill parses all six skillDependencies from frontmatter", () => {
  const deps = parseSkillSkillDependencies(NOVEL_PRODUCTION_ENTRY_SKILL_MD);
  assert.deepEqual(deps.map((dependency) => dependency.coordinate), [...NOVEL_PRODUCTION_COORDINATES]);
  assert.equal(deps.length, 6);
  assert.equal(deps[5]?.placement, "same_runtime");
});

test("planSkillRollout resolves the full novel-production closure from the entry skill", () => {
  for (const coordinate of NOVEL_PRODUCTION_COORDINATES) {
    buildArtifact({ name: coordinate.split("/").pop() ?? "dep", version: "1.2.0", coordinate });
  }
  const deps = parseSkillSkillDependencies(NOVEL_PRODUCTION_ENTRY_SKILL_MD);
  const entry = buildArtifact({
    name: "novel-production",
    coordinate: "github:eternityspring/shuohao-skills/skills/novel-production",
    skillDependencies: deps,
  });

  const plan = planSkillRollout({
    rootArtifactDigest: entry.digest,
    targetScope: { kind: "runtimes", runtimeIds: [createRuntime()] },
  });

  assert.equal(plan.closure.length, 6);
  assert.deepEqual(plan.closure.map((entry2) => entry2.coordinate).sort(), [...NOVEL_PRODUCTION_COORDINATES].sort());
  assert.equal(plan.requiredCount, 7);
  assert.equal(plan.items.length, 7);
  assert.equal(plan.pendingCount, 7);
});
