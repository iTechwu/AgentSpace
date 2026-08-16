// Generated from the source skill repositories listed below.
// Update by refreshing the source clones and regenerating the JSON data; do not hand-edit skill contents here.
//
// 3.3-6：技能内容数据体外置为同目录 preloaded-skill-sources.json（173KB），
// 本模块保留类型与查找门面（导入面不变）。运行时 readFileSync 加载 ——
// 服务端专用包，且避免 tsc/declaration 解析整份 JSON 与膨胀 bundle。

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PreloadedAgentTemplateSkillSourceFile {
  path: string;
  content: string;
}

export interface PreloadedAgentTemplateSkillSource {
  key: string;
  name: string;
  description: string;
  sourceType: "github" | "skills.sh" | "clawhub";
  sourceUrl: string;
  resolvedSourceUrl: string;
  resolvedCommit: string;
  sourcePath: string;
  files: PreloadedAgentTemplateSkillSourceFile[];
}

export const PRELOADED_AGENT_TEMPLATE_SKILL_SOURCES: PreloadedAgentTemplateSkillSource[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "preloaded-skill-sources.json"), "utf8"),
);

export function findPreloadedAgentTemplateSkillSource(input: {
  key: string;
  sourceType: string;
  sourceUrl: string;
}): PreloadedAgentTemplateSkillSource | undefined {
  return PRELOADED_AGENT_TEMPLATE_SKILL_SOURCES.find((source) =>
    source.key === input.key
    && source.sourceType === input.sourceType
    && source.sourceUrl === input.sourceUrl,
  );
}
