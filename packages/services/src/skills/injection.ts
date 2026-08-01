import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonProvider } from "@dofe-agent/domain";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import {
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
} from "@dofe-agent/db";
import { normalizeSkillFilePath } from "../shared/helpers.ts";
import { buildSkillRequirementRuntimeContext } from "./requirements.ts";
import { materializeSkillArtifactFilesSync } from "./skill-artifacts.ts";

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
  workspaceId?: string;
}): MaterializedSkillDirectories {
  if (input.skills.length === 0) {
    return {};
  }

  const compatibilityDir = join(input.workDir, ".agent_context", "skills");
  writeSkillsToRoot(input.skills, compatibilityDir, input.workspaceId);

  const nativeSegments = PROVIDER_NATIVE_SKILL_ROOT_SEGMENTS[input.provider];
  const nativeDir = nativeSegments ? join(input.workDir, ...nativeSegments) : undefined;
  if (nativeDir && nativeDir !== compatibilityDir) {
    writeSkillsToRoot(input.skills, nativeDir, input.workspaceId);
  }

  return {
    compatibilityDir,
    nativeDir,
    primaryDir: nativeDir ?? compatibilityDir,
  };
}

/**
 * Writes the skill projection for a provider root. Per EAD-004 the projection is
 * rebuilt from the immutable content-addressed artifact when one is pinned to
 * the skill — this restores the FULL file set (scripts + binary assets) and
 * verifies each file's digest as it is written. Skills without an artifact
 * (legacy / manually edited) fall back to their text skill_file content.
 */
function writeSkillsToRoot(skills: WorkspaceSkill[], rootDir: string, workspaceId?: string): void {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = join(rootDir, `${sanitizeSkillDirectoryName(skill.name)}-${skill.id.slice(-6)}`);
    mkdirSync(skillDir, { recursive: true });

    const materializedFromArtifact = tryMaterializeFromArtifact(skill, skillDir, workspaceId);
    if (!materializedFromArtifact) {
      for (const file of skill.files) {
        const relativePath = normalizeSkillFilePath(file.path);
        if (!relativePath) {
          continue;
        }
        const targetPath = join(skillDir, relativePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, file.content, "utf8");
      }
    }

    const requirementContext = buildSkillRequirementRuntimeContext(skill.configJson);
    if (requirementContext) {
      writeFileSync(join(skillDir, "skill.config.json"), `${JSON.stringify(requirementContext, null, 2)}\n`, "utf8");
    }
  }
}

function tryMaterializeFromArtifact(skill: WorkspaceSkill, skillDir: string, workspaceId?: string): boolean {
  const digest = readActiveArtifactDigestForSkillSync(skill.id, workspaceId);
  if (!digest) {
    return false;
  }
  const artifact = readSkillArtifactByDigestSync(digest, workspaceId);
  if (!artifact) {
    return false;
  }
  try {
    materializeSkillArtifactFilesSync(artifact, skillDir);
    return true;
  } catch {
    // If the artifact cannot be verified/restored, fall back to text projection
    // rather than failing the whole task. The integrity failure is surfaced
    // separately by the data-protection health check.
    return false;
  }
}

function sanitizeSkillDirectoryName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9一-龥._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "skill";
}
