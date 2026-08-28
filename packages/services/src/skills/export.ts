import { strToU8, zipSync } from "fflate";
import { readWorkspaceSkillSync } from "./skills.ts";

export interface SkillExportManifestEntry {
  id: string;
  name: string;
  description: string;
  sourceType?: string;
  sourceUrl?: string;
  fileCount: number;
  updatedAt: string;
}

export interface ExportedSkillsArchive {
  fileName: string;
  zipBytes: Uint8Array;
  manifest: {
    exportedAt: string;
    skillCount: number;
    skills: SkillExportManifestEntry[];
  };
}

export function exportWorkspaceSkillsArchiveSync(input: {
  skillIds: string[];
  workspaceId?: string;
}): ExportedSkillsArchive {
  const uniqueSkillIds = [...new Set(input.skillIds.map((skillId) => skillId.trim()).filter(Boolean))];
  if (uniqueSkillIds.length === 0) {
    throw new Error("At least one skill must be selected for export.");
  }

  const skills = uniqueSkillIds.map((skillId) => {
    const skill = readWorkspaceSkillSync(skillId, input.workspaceId);
    if (!skill) {
      throw new Error(`Skill "${skillId}" does not exist.`);
    }
    return skill;
  });

  const files: Record<string, Uint8Array> = {};
  const manifestSkills: SkillExportManifestEntry[] = [];
  for (const skill of skills) {
    const skillDir = `${sanitizeArchiveSegment(skill.name)}-${skill.id.slice(-6)}`;
    manifestSkills.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      sourceType: skill.sourceType,
      sourceUrl: skill.sourceUrl,
      fileCount: skill.files.length,
      updatedAt: skill.updatedAt,
    });

    files[`${skillDir}/skill.json`] = strToU8(JSON.stringify({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      sourceType: skill.sourceType ?? "manual",
      sourceUrl: skill.sourceUrl ?? null,
      configJson: skill.configJson ?? "{}",
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    }, null, 2));

    for (const file of skill.files) {
      files[`${skillDir}/${file.path}`] = strToU8(file.content);
    }
  }

  const exportedAt = new Date().toISOString();
  const manifest = {
    exportedAt,
    skillCount: manifestSkills.length,
    skills: manifestSkills,
  };
  files["skills-manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  return {
    fileName: manifestSkills.length === 1
      ? `${sanitizeArchiveSegment(manifestSkills[0]?.name ?? "skill")}.zip`
      : `skills-export-${exportedAt.slice(0, 10)}.zip`,
    zipBytes: zipSync(files, { level: 6 }),
    manifest,
  };
}

function sanitizeArchiveSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "skill";
}
