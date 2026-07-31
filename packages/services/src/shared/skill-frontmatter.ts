function slugifyName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "material";
}

function escapeDoubleQuotedYaml(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Encode a SKILL.md description line; multiline stays one physical YAML line. */
export function formatFrontmatterDescription(description: string): string {
  if (!/[\n\r:#]/.test(description) && !description.includes('"')) {
    return `description: ${description}`;
  }
  return `description: "${escapeDoubleQuotedYaml(description)}"`;
}

export function createDefaultSkillFileContent(name: string, description: string): string {
  const skillName = slugifyName(name);
  const summary = description || `当 Codex 需要应用 ${name} 工作流时使用。`;
  return `---
name: ${skillName}
${formatFrontmatterDescription(summary)}
---

# ${name}

在此描述该技能的工作流、约束条件和可复用资源。
`;
}
