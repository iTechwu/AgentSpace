/**
 * The six production coordinates the thin novel-production entry skill depends
 * on: the five independent upstream skills plus the new shot-generation module.
 */
export const NOVEL_PRODUCTION_COORDINATES = [
  "github:eternityspring/shuohao-skills/skills/novel-characters",
  "github:eternityspring/shuohao-skills/skills/novel-outline",
  "github:eternityspring/shuohao-skills/skills/novel-art",
  "github:eternityspring/shuohao-skills/skills/novel-script",
  "github:eternityspring/shuohao-skills/skills/novel-storyboard",
  "github:eternityspring/shuohao-skills/skills/shot-generation",
] as const;

/**
 * The thin novel-production orchestration entry SKILL.md. It only collects
 * parameters, starts the workflow, and explains progress — it does NOT copy the
 * five production implementations.
 */
export const NOVEL_PRODUCTION_ENTRY_SKILL_MD = [
  "---",
  "name: novel-production",
  "description: 编排小说改编生产：收集参数、启动 Workflow、解释进度。",
  "skillDependencies:",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/novel-characters",
  "    version: ^1.0.0",
  "    placement: workflow",
  "    required: true",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/novel-outline",
  "    version: ^1.0.0",
  "    placement: workflow",
  "    required: true",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/novel-art",
  "    version: ^1.0.0",
  "    placement: workflow",
  "    required: true",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/novel-script",
  "    version: ^1.0.0",
  "    placement: workflow",
  "    required: true",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/novel-storyboard",
  "    version: ^1.0.0",
  "    placement: workflow",
  "    required: true",
  "  - coordinate: github:eternityspring/shuohao-skills/skills/shot-generation",
  "    version: ^1.0.0",
  "    placement: same_runtime",
  "    required: true",
  "---",
  "",
  "# novel-production",
  "",
  "编排入口 Skill：收集参数（原文、目标集数、画风、预算），启动 Workflow 模板，解释进度。",
  "不在内部复制五个生产 Skill 的实现。",
  "",
].join("\n");
