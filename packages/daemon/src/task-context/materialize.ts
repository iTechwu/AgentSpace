// 3.5-4：自 task-context.ts 拆出——skills/知识页/附件落盘到任务 workDir。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeRecord } from "@dofe-agent/db";
import type { ActiveEmployee, KnowledgePage, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import {
  listEmployeeKnowledgePagesSync,
  materializeWorkspaceSkillsForProvider,
  readWorkspaceAttachmentBytesSync,
  readWorkspaceStateSync,
  type MaterializedSkillDirectories,
} from "@dofe-agent/services";
import type { ParsedTaskPayload } from "./payload.ts";

export function materializeAgentSkills(
  skills: WorkspaceSkill[],
  workDir: string,
  provider: AgentRuntimeRecord["provider"] = "gemini",
  digestBySkillId?: Map<string, string>,
  workspaceId?: string,
): MaterializedSkillDirectories {
  return materializeWorkspaceSkillsForProvider({
    skills,
    workDir,
    provider,
    ...(workspaceId ? { workspaceId } : {}),
    ...(digestBySkillId ? { digestBySkillId } : {}),
  });
}

export function resolveAgentKnowledgePages(
  _workspaceState: ReturnType<typeof readWorkspaceStateSync>,
  agentProfile: ActiveEmployee | undefined,
  workspaceId?: string,
): KnowledgePage[] {
  if (!agentProfile) {
    return [];
  }

  return listEmployeeKnowledgePagesSync(agentProfile.name, workspaceId);
}

export function materializeAgentKnowledgePages(
  pages: KnowledgePage[],
  workDir: string,
): string | undefined {
  if (pages.length === 0) {
    return undefined;
  }

  const knowledgeDir = join(workDir, ".agent_context", "knowledge");
  const pagesDir = join(knowledgeDir, "pages");
  rmSync(knowledgeDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });

  const manifestPages = pages.map((page, index) => {
    const fileName = `${String(index + 1).padStart(2, "0")}-${sanitizePathSegment(page.title)}-${page.id.slice(-6)}.md`;
    writeFileSync(join(pagesDir, fileName), page.contentMarkdown, "utf8");
    return {
      id: page.id,
      title: page.title,
      tags: page.tags,
      assignmentMode: page.assignmentMode ?? "all_agents",
      updatedAt: page.updatedAt,
      path: `pages/${fileName}`,
    };
  });

  writeFileSync(
    join(knowledgeDir, "manifest.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      pageCount: manifestPages.length,
      pages: manifestPages,
    }, null, 2),
    "utf8",
  );

  return knowledgeDir;
}

export function materializeAttachments(
  attachments: ParsedTaskPayload["attachments"],
  workDir: string,
): string[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const targetDir = join(workDir, "attachments");
  mkdirSync(targetDir, { recursive: true });

  return attachments.map((attachment, index) => {
    const safeName = sanitizePathSegment(attachment.fileName.replace(/[\\/]/g, "-"));
    const targetPath = join(targetDir, `${String(index + 1).padStart(2, "0")}-${safeName}`);
    writeFileSync(targetPath, readWorkspaceAttachmentBytesSync(attachment));
    return `- ${attachment.fileName} (${targetPath})`;
  });
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "attachment";
}
