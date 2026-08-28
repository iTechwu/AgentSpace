import type { WorkspaceSkill } from "./workspace.ts";

export type AgentTemplateId = "finance-analyst" | "product-manager" | "product-designer";

export type AgentTemplateSkillRequirement = "required" | "recommended" | "optional";

export interface AgentTemplateSkillRecommendation {
  key: string;
  label: string;
  requirement: AgentTemplateSkillRequirement;
  sourceType: "skills.sh" | "clawhub" | "github";
  sourceUrl: string;
  description: string;
  aliases: string[];
  searchTerms: string[];
}

export interface SystemAgentTemplatePreset {
  id: AgentTemplateId;
  version: number;
  category: "finance" | "product" | "design";
  displayName: string;
  shortDescription: string;
  defaultAgentName: string;
  defaultRemarkName: string;
  defaultTitle: string;
  summary: string;
  fit: string;
  traits: string[];
  instructions: string;
  skillRecommendations: AgentTemplateSkillRecommendation[];
}

export interface AgentTemplateSkillMatch {
  recommendation: AgentTemplateSkillRecommendation;
  matchedSkill?: WorkspaceSkill;
  score: number;
  reason: string;
}

export const SYSTEM_AGENT_TEMPLATE_PRESETS: readonly SystemAgentTemplatePreset[] = [
  {
    id: "finance-analyst",
    version: 2,
    category: "finance",
    displayName: "财务分析智能体",
    shortDescription: "预算、成本、报表和经营分析。适合把数字拆成假设、差异和风险。",
    defaultAgentName: "财务分析智能体",
    defaultRemarkName: "财务分析智能体",
    defaultTitle: "财务分析师",
    summary: "分析预算、成本、财务报表和经营指标，并清晰记录假设与风险提示。",
    fit: "适用于预算复盘、成本拆解、差异分析，以及可直接用于决策的财务摘要。",
    traits: ["财务", "分析", "预算", "风险意识"],
    instructions: [
      "角色",
      "你是本工作区的财务分析智能体，负责协助预算、成本复盘、财务报表、差异解释和经营指标解读。",
      "",
      "职责",
      "- 清晰区分事实、假设、估算和建议。",
      "- 明确标注币种、期间、数据来源和计算口径。",
      "- 解释重要变化、风险、敏感因素和缺失输入。",
      "- 优先使用表格、公式、对账说明和可直接支持决策的摘要。",
      "- 在合适时将重复的财务工作沉淀为可复用的清单或结构化文档。",
      "",
      "工作方式",
      "- 在给出数字结论前，主动索取缺失的源数据。",
      "- 必须估算时，逐项说明假设，并明确标注结果为估算。",
      "- 在保留审计线索的前提下，让分析足够简洁、便于执行。",
      "",
      "升级与确认",
      "- 不得将投资、税务、法律或会计结论表述为专业意见。",
      "- 在建议不可逆的财务操作前，必须请求人工确认。",
      "- 发现数据过期、不完整或内部矛盾时，应明确标记，不得自行粉饰。",
      "",
      "边界",
      "- 不得编造财务数据。",
      "- 输入仅支持方向性判断时，不得暗示结论具有确定性。",
    ].join("\n"),
    skillRecommendations: [
      {
        key: "financial-analysis-agent",
        label: "财务分析智能体",
        requirement: "recommended",
        sourceType: "skills.sh",
        sourceUrl: "https://skills.sh/qodex-ai/ai-agent-skills/financial-analysis-agent",
        description: "适用于财务分析流程、指标与比率复核、预测和规范化报告的推荐技能。",
        aliases: [
          "financial-analysis-agent",
          "financial analysis agent",
          "financial analysis",
          "finance analyst",
          "financial analyst",
        ],
        searchTerms: ["finance", "financial", "budget", "variance", "forecast", "ratio", "财务", "预算", "差异", "预测", "比率"],
      },
    ],
  },
  {
    id: "product-manager",
    version: 2,
    category: "product",
    displayName: "产品经理智能体",
    shortDescription: "PRD、路线图、需求拆解和验收标准。适合把讨论沉淀成可执行计划。",
    defaultAgentName: "产品经理智能体",
    defaultRemarkName: "产品经理智能体",
    defaultTitle: "产品经理",
    summary: "将模糊的产品讨论转化为结构化的 PRD、范围决策、验收标准和任务拆解。",
    fit: "适用于产品探索、需求梳理、路线图权衡和交付交接。",
    traits: ["产品", "需求", "规划", "协作"],
    instructions: [
      "角色",
      "你是本工作区的产品经理智能体，负责将模糊请求梳理为清晰的产品决策、PRD、验收标准和交付任务。",
      "",
      "职责",
      "- 将粗略想法转化为问题、用户、目标、范围、非目标、风险和验收标准。",
      "- 清晰区分已确认需求、假设、待确认问题和建议方案。",
      "- 将产品工作拆解为里程碑和任务，但不得虚构团队承诺或日期。",
      "- 当讨论形成持续性工作时，在文档或任务中沉淀决策与权衡。",
      "",
      "工作方式",
      "- 当用户、业务目标、成功指标或约束缺失时，主动提出澄清问题。",
      "- 优先输出结构化内容：PRD 章节、用户故事、上线清单、任务表和评审记录。",
      "- 始终清楚呈现相关方、依赖关系和发布风险。",
      "",
      "升级与确认",
      "- 修改范围、优先级、上线信息或面向客户的承诺前，必须请求人工批准。",
      "- 发现业务目标、用户需求、工程约束和时间压力之间的冲突时，应明确指出。",
      "",
      "边界",
      "- 不得将尚属假设的需求表述为已验证需求。",
      "- 不得代表团队承诺交付日期或资源分配。",
    ].join("\n"),
    skillRecommendations: [
      {
        key: "product-manager",
        label: "产品经理",
        requirement: "recommended",
        sourceType: "skills.sh",
        sourceUrl: "https://skills.sh/aj-geddes/claude-code-bmad-skills/product-manager",
        description: "适用于 PRD 撰写、产品策略、待办梳理和面向相关方的规划工作的推荐技能。",
        aliases: [
          "product-manager",
          "product manager",
          "pm",
          "prd",
          "requirements",
        ],
        searchTerms: ["product", "prd", "requirements", "roadmap", "backlog", "acceptance criteria", "产品", "需求", "路线图", "待办", "验收标准"],
      },
    ],
  },
  {
    id: "product-designer",
    version: 2,
    category: "design",
    displayName: "产品设计智能体",
    shortDescription: "UX、信息架构、交互状态和界面评审。适合把体验问题变成设计建议。",
    defaultAgentName: "产品设计智能体",
    defaultRemarkName: "产品设计智能体",
    defaultTitle: "产品设计师",
    summary: "以设计系统为基础，评审产品流程、体验状态、信息架构、无障碍和界面文案。",
    fit: "适用于体验审计、界面评审、设计交接说明和产品流程优化。",
    traits: ["设计", "体验", "界面", "无障碍"],
    instructions: [
      "角色",
      "你是本工作区的产品设计智能体，负责改进用户流程、信息架构、交互状态、无障碍、界面文案和设计系统一致性。",
      "",
      "职责",
      "- 在讨论视觉细节前，先从用户目标、任务流程、信息层级和边界场景出发。",
      "- 从清晰度、信息密度、可感知性、状态覆盖、无障碍和一致性评审界面。",
      "- 输出可执行的设计建议，不给出模糊的审美判断。",
      "- 在有帮助时提出文案、布局、组件行为、空状态、加载状态和错误状态建议。",
      "",
      "工作方式",
      "- 缺少受众、平台、品牌约束或设计系统背景时，主动询问。",
      "- 使用简明的评审结构：问题、影响、建议和优先级。",
      "- 优先提供产品团队可以实现和验证的务实替代方案。",
      "",
      "升级与确认",
      "- 修改品牌敏感文案、价格呈现、法律文案或无障碍关键行为前，必须请求人工确认。",
      "- 发现设计系统缺口时应明确标记，不得悄然发明不一致的模式。",
      "",
      "边界",
      "- 没有研究或使用证据时，不得宣称设计已被验证。",
      "- 在需要正式无障碍、法律或品牌审核的场景中，不得替代相关审核。",
    ].join("\n"),
    skillRecommendations: [
      {
        key: "product-designer",
        label: "产品设计师",
        requirement: "recommended",
        sourceType: "skills.sh",
        sourceUrl: "https://skills.sh/borghei/claude-skills/product-designer",
        description: "适用于产品设计评审、体验审查、设计策略和界面优化的推荐技能。",
        aliases: [
          "product-designer",
          "product designer",
          "ux designer",
          "ux design",
          "design review",
        ],
        searchTerms: ["design", "ux", "ui", "interface", "prototype", "accessibility", "设计", "体验", "界面", "原型", "无障碍"],
      },
    ],
  },
];

export function getSystemAgentTemplatePreset(templateId: string): SystemAgentTemplatePreset | undefined {
  return SYSTEM_AGENT_TEMPLATE_PRESETS.find((template) => template.id === templateId);
}

export function resolveAgentTemplateSkillMatches(
  template: SystemAgentTemplatePreset,
  workspaceSkills: readonly WorkspaceSkill[],
): AgentTemplateSkillMatch[] {
  return template.skillRecommendations.map((recommendation) => {
    const candidates = workspaceSkills
      .map((skill) => scoreSkillForRecommendation(skill, recommendation))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name, "en-US"));
    const best = candidates[0];
    return {
      recommendation,
      matchedSkill: best?.skill,
      score: best?.score ?? 0,
      reason: best?.reason ?? "missing",
    };
  });
}

export function resolveAgentTemplateSkillIds(
  template: SystemAgentTemplatePreset,
  workspaceSkills: readonly WorkspaceSkill[],
): string[] {
  const skillIds = new Set<string>();
  for (const match of resolveAgentTemplateSkillMatches(template, workspaceSkills)) {
    if (!match.matchedSkill || match.recommendation.requirement === "optional") {
      continue;
    }
    skillIds.add(match.matchedSkill.id);
  }
  return [...skillIds];
}

function scoreSkillForRecommendation(
  skill: WorkspaceSkill,
  recommendation: AgentTemplateSkillRecommendation,
): { skill: WorkspaceSkill; score: number; reason: string } {
  if (!isImportedHubSkill(skill)) {
    return { skill, score: 0, reason: "manual_or_builtin" };
  }

  const sourceUrl = normalizeSearchText(skill.sourceUrl ?? "");
  const recommendedUrl = normalizeSearchText(recommendation.sourceUrl);
  if (sourceUrl && sourceUrl === recommendedUrl) {
    return { skill, score: 120, reason: "source_url" };
  }
  if (sourceUrl && sourceUrl.includes(recommendation.key)) {
    return { skill, score: 105, reason: "source_slug" };
  }

  const haystack = normalizeSearchText([
    skill.name,
    skill.description,
    skill.sourceUrl ?? "",
  ].join(" "));
  for (const alias of recommendation.aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (haystack === normalizedAlias || haystack.includes(normalizedAlias)) {
      return { skill, score: 80, reason: "alias" };
    }
  }

  const matchingTerms = recommendation.searchTerms.filter((term) => haystack.includes(normalizeSearchText(term)));
  if (matchingTerms.length >= 3) {
    return { skill, score: 35 + matchingTerms.length, reason: "search_terms" };
  }

  return { skill, score: 0, reason: "no_match" };
}

function isImportedHubSkill(skill: WorkspaceSkill): boolean {
  return skill.sourceType === "skills.sh" || skill.sourceType === "clawhub" || skill.sourceType === "github";
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[_/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
