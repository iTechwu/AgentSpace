import {
  readRuntimeAppCatalogItemSync,
  readRuntimeInstalledAppSync,
  upsertRuntimeAppSkillBindingSync,
  type RuntimeAppCatalogSource,
} from "@dofe-agent/db";
import { createWorkspaceSkillSync, listWorkspaceSkillsSync, upsertWorkspaceSkillFileSync } from "../skills/skills.ts";

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
  const existing = listWorkspaceSkillsSync(input.workspaceId).find((skill) =>
    typeof skill.configJson === "string" &&
    skill.sourceType === "clihub_runtime_app" &&
    readConfigAppKey(skill.configJson) === `${catalog.source}:${catalog.name}`,
  );
  if (existing) {
    upsertRuntimeAppSkillBindingSync({
      workspaceId: input.workspaceId,
      runtimeAppId: installed.id,
      skillId: existing.id,
      source: catalog.source,
      name: catalog.name,
    });
    return { status: "existing", skillId: existing.id };
  }

  const skillContent = await resolveSkillMdContent(catalog.skillMd, input.fetchImpl ?? fetch);
  const skill = createWorkspaceSkillSync({
    name: skillName,
    description: catalog.description || `${catalog.displayName} CLI-Hub 运行时应用使用说明。`,
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

async function resolveSkillMdContent(
  skillMd: string,
  fetchImpl: typeof fetch,
): Promise<{ content: string; sourceUrl?: string; warning?: string }> {
  const trimmed = skillMd.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const response = await fetchImpl(trimmed, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`获取 SKILL.md 失败: ${response.status} ${response.statusText}`);
    }
    return { content: await response.text(), sourceUrl: trimmed };
  }
  return {
    content: [
      "# CLI-Hub 运行时应用",
      "",
      `CLI-Hub 目录引用的 SKILL.md 位于：${trimmed}`,
      "",
      "此技能仅描述如何使用该工具，不证明软件已安装。",
      "DofeAgent 仅在绑定的运行时报告该应用已安装并启用时，才在任务上下文中暴露此技能。",
    ].join("\n"),
    warning: "目录 SKILL.md 是相对路径；已创建占位技能，待源文件可解析后替换。",
  };
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
