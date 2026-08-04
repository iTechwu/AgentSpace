import {
  readRuntimeAppCatalogItemSync,
  readRuntimeInstalledAppSync,
  upsertRuntimeAppSkillBindingSync,
  type RuntimeAppCatalogSource,
} from "@dofe-agent/db";
import { createWorkspaceSkillSync, listWorkspaceSkillsSync, upsertWorkspaceSkillFileSync } from "../skills/skills.ts";
import { parseSkillMarkdown } from "../skills/package/skill-md.ts";
import { formatFrontmatterDescription } from "../shared/skill-frontmatter.ts";

export interface RuntimeAppSkillSyncResult {
  status: "created" | "existing" | "not_available";
  skillId?: string;
  warning?: string;
}

export async function syncRuntimeAppSkill(input: {
  workspaceId: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<RuntimeAppSkillSyncResult> {
  const installed = readRuntimeInstalledAppSync(input);
  if (!installed || installed.status !== "installed" || !installed.enabled) {
    return { status: "not_available", warning: "运行时应用未安装在所选运行时上。" };
  }
  const catalog = readRuntimeAppCatalogItemSync(input.source, input.name);
  if (!catalog?.skillMd?.trim()) {
    return { status: "not_available", warning: "目录项未声明 SKILL.md。" };
  }

  const skillName = `clihub-${catalog.name}`;
  const skillDescription = catalog.description || `${catalog.displayName} CLI-Hub 运行时应用使用说明。`;
  const skillContent = await resolveSkillMdContent({
    skillMd: catalog.skillMd,
    skillName,
    description: skillDescription,
    displayName: catalog.displayName,
    entryPoint: catalog.entryPoint,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const existing = listWorkspaceSkillsSync(input.workspaceId).find((skill) =>
    typeof skill.configJson === "string" &&
    skill.sourceType === "clihub_runtime_app" &&
    readConfigAppKey(skill.configJson) === `${catalog.source}:${catalog.name}`,
  );
  if (existing) {
    const existingSkillMd = existing.files.find((file) => file.path === "SKILL.md");
    if (existingSkillMd?.content !== skillContent.content) {
      upsertWorkspaceSkillFileSync({
        skillId: existing.id,
        fileId: existingSkillMd?.id,
        path: "SKILL.md",
        content: skillContent.content,
      }, input.workspaceId);
    }
    upsertRuntimeAppSkillBindingSync({
      workspaceId: input.workspaceId,
      runtimeAppId: installed.id,
      skillId: existing.id,
      source: catalog.source,
      name: catalog.name,
    });
    return { status: "existing", skillId: existing.id, warning: skillContent.warning };
  }

  const skill = createWorkspaceSkillSync({
    name: skillName,
    description: skillDescription,
    content: skillContent.content,
    sourceType: "clihub_runtime_app",
    sourceUrl: skillContent.sourceUrl,
    configJson: JSON.stringify({
      runtimeApp: {
        source: catalog.source,
        name: catalog.name,
        displayName: catalog.displayName,
        entryPoint: catalog.entryPoint,
        requiresInstalledRuntimeApp: true,
      },
    }),
  }, input.workspaceId);
  if (!skill.files.some((file) => file.path === "SKILL.md")) {
    upsertWorkspaceSkillFileSync({
      skillId: skill.id,
      path: "SKILL.md",
      content: skillContent.content,
    }, input.workspaceId);
  }
  upsertRuntimeAppSkillBindingSync({
    workspaceId: input.workspaceId,
    runtimeAppId: installed.id,
    skillId: skill.id,
    source: catalog.source,
    name: catalog.name,
  });
  return { status: "created", skillId: skill.id, warning: skillContent.warning };
}

export async function resolveSkillMdContent(
  input: {
    skillMd: string;
    skillName: string;
    description: string;
    displayName: string;
    entryPoint?: string;
    fetchImpl: typeof fetch;
  },
): Promise<{ content: string; sourceUrl?: string; warning?: string }> {
  const trimmed = input.skillMd.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const response = await input.fetchImpl(trimmed, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`获取 SKILL.md 失败: ${response.status} ${response.statusText}`);
    }
    const remoteContent = await response.text();
    if (parseSkillMarkdown(remoteContent).ok) {
      return { content: remoteContent, sourceUrl: trimmed };
    }
    return {
      content: createRuntimeAppFallbackSkill(input),
      sourceUrl: trimmed,
      warning: "目录 URL 未返回有效的 SKILL.md；已生成安全的运行时应用使用说明。",
    };
  }
  return {
    content: createRuntimeAppFallbackSkill(input, trimmed),
    warning: "目录 SKILL.md 是相对路径；已创建占位技能，待源文件可解析后替换。",
  };
}

function createRuntimeAppFallbackSkill(
  input: Pick<Parameters<typeof resolveSkillMdContent>[0], "skillName" | "description" | "displayName" | "entryPoint">,
  declaredPath?: string,
): string {
  const command = input.entryPoint?.trim();
  return [
    "---",
    `name: ${input.skillName}`,
    formatFrontmatterDescription(input.description),
    "---",
    "",
    `# ${input.displayName}`,
    "",
    "此 Skill 仅描述已安装 CLI-Hub 运行时应用的低风险使用方式。",
    command ? `入口命令：\`${command}\`。优先使用 \`${command} --help\` 或等价只读命令确认可用性。` : "目录未声明入口命令，不得猜测或执行未知命令。",
    "应用是否可执行以当前 Runtime 的安装和启用状态为准。",
    declaredPath ? `目录声明的源文件路径：\`${declaredPath}\`。` : "",
    "",
  ].filter(Boolean).join("\n");
}

function readConfigAppKey(configJson: string): string | undefined {
  try {
    const parsed = JSON.parse(configJson) as {
      runtimeApp?: {
        source?: unknown;
        name?: unknown;
      };
    };
    if (typeof parsed.runtimeApp?.source === "string" && typeof parsed.runtimeApp.name === "string") {
      return `${parsed.runtimeApp.source}:${parsed.runtimeApp.name}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
