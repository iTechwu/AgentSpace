import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { buildSkillRunnerCommandName } from "@dofe-agent/domain";
import {
  buildAndPersistSkillArtifactSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
} from "../index.ts";
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

test("materializeWorkspaceSkillsForProvider writes requirement context without config or secret values", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-injection-"));
  try {
    const skill = createSkill();
    skill.configJson = JSON.stringify({
      requirements: [
        { kind: "project", value: "repository" },
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
      ],
      requirementConfiguration: {
        projectWorkDir: "/workspace/repository",
        values: {
          NOTION_DATABASE_ID: "db-123",
        },
      },
    });
    const result = materializeWorkspaceSkillsForProvider({ skills: [skill], workDir, provider: "codex" });
    const config = readFileSync(join(result.nativeDir!, "research-pack-123456", "skill.config.json"), "utf8");
    assert.match(config, /\/workspace\/repository/);
    assert.match(config, /credential_center_required/);
    assert.equal(config.includes("db-123"), false);
    assert.equal(config.includes("secret-token"), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("artifact executable files are projected as Runner stubs instead of raw scripts", () => {
  resetWorkspaceStateSync();
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-skill-runner-projection-"));
  try {
    const skill = createWorkspaceSkillSync({
      name: "artifact runner",
      content: "# Artifact Runner\n",
    });
    const rawScript = "console.log('RAW-SCRIPT-MARKER');\n";
    buildAndPersistSkillArtifactSync({
      skillId: skill.id,
      name: skill.name,
      version: "1.0.0",
      files: [
        { path: "SKILL.md", bytes: new TextEncoder().encode("# Artifact Runner\n") },
        { path: "scripts/run.mjs", bytes: new TextEncoder().encode(rawScript), mode: "0755" },
        { path: "scripts/helper.js", bytes: new TextEncoder().encode("console.log('RAW-HELPER-MARKER');\n"), mode: "0644" },
        { path: "bin/unknown", bytes: new TextEncoder().encode("opaque executable"), mode: "0755" },
      ],
      entrypoints: [{ id: "run", kind: "script", path: "scripts/run.mjs", runtime: "node" }],
    });

    const result = materializeWorkspaceSkillsForProvider({ skills: [skill], workDir, provider: "codex" });
    const skillDir = join(result.nativeDir!, `artifact-runner-${skill.id.slice(-6)}`);
    const projectedScript = readFileSync(join(skillDir, "scripts", "run.mjs"), "utf8");
    const command = buildSkillRunnerCommandName(skill.name, skill.id, "run");

    assert.equal(projectedScript.includes("RAW-SCRIPT-MARKER"), false);
    assert.match(projectedScript, new RegExp(command));
    assert.equal(statSync(join(skillDir, "scripts", "run.mjs")).mode & 0o777, 0o555);
    assert.equal(readFileSync(join(skillDir, "scripts", "helper.js"), "utf8").includes("RAW-HELPER-MARKER"), false);
    assert.equal(statSync(join(skillDir, "scripts", "helper.js")).mode & 0o777, 0o444);
    assert.equal(statSync(join(skillDir, "bin", "unknown")).mode & 0o777, 0o444);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
