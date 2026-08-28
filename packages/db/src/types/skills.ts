// 技能 / 技能分配 / 知识记录（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";

export interface StoredSkillRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  sourceType: string;
  sourceUrl?: string;
  configJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillFileRecord {
  id: string;
  skillId: string;
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAgentSkillRecord {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  skillArtifactDigest?: string;
  /** Rollout revision pin (e.g. "v1") that fixes new tasks to a specific installation revision until the rollout switches. */
  rolloutPin?: string;
  createdAt: string;
}

export interface StoredAgentSkillRequirementConfigRecord {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  configJson: string;
  encryptedSecretsJson: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredKnowledgeAssignmentPolicyRecord {
  workspaceId: string;
  knowledgePageId: string;
  assignmentMode: KnowledgeAssignmentMode;
  updatedAt: string;
  updatedBy: string;
}

export interface StoredAgentKnowledgePageRecord {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  knowledgePageId: string;
  createdAt: string;
  createdBy: string;
}

export interface StoredSkillImportEventRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  skillName: string;
  sourceType: string;
  sourceUrl?: string;
  importMode: "created" | "renamed" | "replaced";
  metadataJson: string;
  importedAt: string;
}
