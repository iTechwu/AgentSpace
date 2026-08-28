// 技能导入的导入命名与 skills.sh 命令解析（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { sameValue } from "../../shared/helpers.ts";
import { isBuiltinSkill } from "../skills.ts";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";

export function createUniqueImportSkillName(skills: WorkspaceSkill[], baseName: string): string {
  const trimmedBaseName = baseName.trim() || "新建 Skill";
  let candidate = trimmedBaseName;
  let counter = 2;
  while (
    isBuiltinSkill(candidate) ||
    skills.some((skill) => sameValue(skill.name, candidate))
  ) {
    candidate = `${trimmedBaseName} ${counter}`;
    counter += 1;
  }
  return candidate;
}
export function parseSkillsShInstallCommand(html: string): { owner: string; repo: string; skillSlug: string } | null {
  const decodedHtml = decodeHtmlEntities(html);
  const match = decodedHtml.match(
    /npx skills add https:\/\/github\.com\/([^/\s"<']+)\/([^/\s"<']+)\s+--skill\s+(?:"([^"]+)"|'([^']+)'|([^<\s"']+))/i,
  );
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    skillSlug: match[3] ?? match[4] ?? match[5],
  };
}
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}
