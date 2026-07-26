import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { materializeWorkspaceSkillsForProvider } from "./injection.ts";

function createSkill(): WorkspaceSkill {
  return {
    id: "skill-research-123456",
    name: "research pack",
    description: "Research helper",
    files: [
      {
        id: "file-1",
        path: "SKILL.md",
        content: "# Research Pack",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      {
        id: "file-2",
        path: "templates/checklist.md",
        content: "- confirm sources",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
    ],
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };
}

test("materializeWorkspaceSkillsForProvider dual-writes provider-native and compatibility paths", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-injection-"));

  try {
    const result = materializeWorkspaceSkillsForProvider({
      skills: [createSkill()],
      workDir,
      provider: "codex",
    });

    assert.equal(result.compatibilityDir, join(workDir, ".agent_context", "skills"));
    assert.equal(result.nativeDir, join(workDir, ".codex", "skills"));
    assert.equal(result.primaryDir, join(workDir, ".codex", "skills"));

    const skillDirName = "research-pack-123456";
    assert.equal(existsSync(join(result.compatibilityDir!, skillDirName, "SKILL.md")), true);
    assert.equal(existsSync(join(result.nativeDir!, skillDirName, "SKILL.md")), true);
    assert.equal(
      readFileSync(join(result.nativeDir!, skillDirName, "templates", "checklist.md"), "utf8"),
      "- confirm sources",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("materializeWorkspaceSkillsForProvider falls back to compatibility-only paths for unsupported native providers", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-injection-"));

  try {
    const result = materializeWorkspaceSkillsForProvider({
      skills: [createSkill()],
      workDir,
      provider: "gemini",
    });

    assert.equal(result.compatibilityDir, join(workDir, ".agent_context", "skills"));
    assert.equal(result.nativeDir, undefined);
    assert.equal(result.primaryDir, join(workDir, ".agent_context", "skills"));
    assert.equal(existsSync(join(result.compatibilityDir!, "research-pack-123456", "SKILL.md")), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("materializeWorkspaceSkillsForProvider writes configured requirements without secret values", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-injection-"));
  try {
    const skill = createSkill();
    skill.configJson = JSON.stringify({
      requirements: [
        { kind: "project", value: "repository" },
        { kind: "secret", value: "API_KEY" },
      ],
      requirementConfiguration: {
        projectWorkDir: "/workspace/repository",
        values: {},
      },
    });
    const result = materializeWorkspaceSkillsForProvider({ skills: [skill], workDir, provider: "codex" });
    const config = readFileSync(join(result.nativeDir!, "research-pack-123456", "skill.config.json"), "utf8");
    assert.match(config, /\/workspace\/repository/);
    assert.match(config, /credential_center_required/);
    assert.equal(config.includes("not-stored"), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
