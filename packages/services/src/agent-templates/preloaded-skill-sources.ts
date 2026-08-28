// Generated from the source skill repositories listed below.
// Update by refreshing the source clones and regenerating the JSON data; do not hand-edit skill contents here.
//
// 3.3-6：技能内容数据体外置为同目录 preloaded-skill-sources.json（173KB），
// 本模块保留类型与查找门面（导入面不变）。
// 加载方式：静态 JSON import（node strip-types 与 Turbopack 均原生支持）。
// 此前用 readFileSync(join(import.meta.dirname, ...))，但 Turbopack 产物不定义
// import.meta.dirname，next build 在 page-data 收集阶段即抛 ERR_INVALID_ARG_TYPE。

import preloadedSkillSourcesJson from "./preloaded-skill-sources.json" with { type: "json" };

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

// JSON import 的字面量类型会被拓宽（sourceType: string），此处断言收窄——数据为生成物，受控。
export const PRELOADED_AGENT_TEMPLATE_SKILL_SOURCES =
  preloadedSkillSourcesJson as PreloadedAgentTemplateSkillSource[];

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
