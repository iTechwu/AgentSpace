import {
  getSystemAgentTemplatePreset,
  resolveAgentTemplateSkillIds,
  resolveAgentTemplateSkillMatches,
  type AgentTemplateSkillMatch,
  type SystemAgentTemplatePreset,
} from "@dofe-agent/domain";
import { listWorkspaceSkillsSync } from "../skills/skills.ts";

export interface ResolvedAgentTemplateForWorkspace {
  template: SystemAgentTemplatePreset;
  skillIds: string[];
  skillMatches: AgentTemplateSkillMatch[];
}

export function resolveSystemAgentTemplateForWorkspaceSync(
  templateId: string,
  workspaceId?: string,
): ResolvedAgentTemplateForWorkspace {
  const template = getSystemAgentTemplatePreset(templateId);
  if (!template) {
    throw new Error(`Unknown agent template "${templateId}".`);
  }

  const workspaceSkills = listWorkspaceSkillsSync(workspaceId);
  return {
    template,
    skillIds: resolveAgentTemplateSkillIds(template, workspaceSkills),
    skillMatches: resolveAgentTemplateSkillMatches(template, workspaceSkills),
  };
}
