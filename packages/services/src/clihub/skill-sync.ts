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
    return { status: "not_available", warning: "Runtime app is not installed on the selected runtime." };
  }
  const catalog = readRuntimeAppCatalogItemSync(input.source, input.name);
  if (!catalog?.skillMd?.trim()) {
    return { status: "not_available", warning: "Catalog item does not declare SKILL.md." };
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
    description: catalog.description || `${catalog.displayName} CLI-Hub runtime app usage notes.`,
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
      throw new Error(`Failed to fetch SKILL.md: ${response.status} ${response.statusText}`);
    }
    return { content: await response.text(), sourceUrl: trimmed };
  }
  return {
    content: [
      "# CLI-Hub runtime app",
      "",
      `The CLI-Hub catalog references SKILL.md at: ${trimmed}`,
      "",
      "This skill only describes how to use the tool. It is not proof that the software is installed.",
      "DofeAgent will expose this skill in task context only when the bound runtime reports the app as installed and enabled.",
    ].join("\n"),
    warning: "Catalog SKILL.md is a relative path; a placeholder skill was created until the source file can be resolved.",
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
