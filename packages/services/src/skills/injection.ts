import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonProvider } from "@dofe-agent/domain";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { normalizeSkillFilePath } from "../shared/helpers.ts";
import { buildSkillRequirementRuntimeContext } from "./requirements.ts";

const PROVIDER_NATIVE_SKILL_ROOT_SEGMENTS: Partial<Record<DaemonProvider, readonly string[]>> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  opencode: [".config", "opencode", "skills"],
  openclaw: [".config", "openclaw", "skills"],
  nanobot: [".config", "nanobot", "skills"],
};

export interface MaterializedSkillDirectories {
  compatibilityDir?: string;
  nativeDir?: string;
  primaryDir?: string;
}

export function materializeWorkspaceSkillsForProvider(input: {
  skills: WorkspaceSkill[];
  workDir: string;
  provider: DaemonProvider;
}): MaterializedSkillDirectories {
  if (input.skills.length === 0) {
    return {};
  }

  const compatibilityDir = join(input.workDir, ".agent_context", "skills");
  writeSkillsToRoot(input.skills, compatibilityDir);

  const nativeSegments = PROVIDER_NATIVE_SKILL_ROOT_SEGMENTS[input.provider];
  const nativeDir = nativeSegments ? join(input.workDir, ...nativeSegments) : undefined;
  if (nativeDir && nativeDir !== compatibilityDir) {
    writeSkillsToRoot(input.skills, nativeDir);
  }

  return {
    compatibilityDir,
    nativeDir,
    primaryDir: nativeDir ?? compatibilityDir,
  };
}

function writeSkillsToRoot(skills: WorkspaceSkill[], rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = join(rootDir, `${sanitizeSkillDirectoryName(skill.name)}-${skill.id.slice(-6)}`);
    mkdirSync(skillDir, { recursive: true });

    for (const file of skill.files) {
      const relativePath = normalizeSkillFilePath(file.path);
      if (!relativePath) {
        continue;
      }

      const targetPath = join(skillDir, relativePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content, "utf8");
    }

    const requirementContext = buildSkillRequirementRuntimeContext(skill.configJson);
    if (requirementContext) {
      writeFileSync(join(skillDir, "skill.config.json"), `${JSON.stringify(requirementContext, null, 2)}\n`, "utf8");
    }
  }
}

function sanitizeSkillDirectoryName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "skill";
}
