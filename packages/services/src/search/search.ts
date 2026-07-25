import type {
  DofeAgentState,
  WorkspaceMessage,
  ActiveEmployee,
  TaskRecord,
  WorkspaceSkill,
  ChannelDocument,
  ChannelDocumentVersion,
  KnowledgePage,
} from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { listWorkspaceSkillsSync } from "../skills/skills.ts";
import { listEmployeeKnowledgePageIdsSync } from "../knowledge/assignments.ts";

export type SearchResultType = "message" | "document" | "task" | "agent" | "skill" | "knowledge";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  score: number;
  meta?: Record<string, string>;
}

export interface SearchOptions {
  types?: SearchResultType[];
  channelName?: string;
  assignedAgentName?: string;
  limit?: number;
  workspaceId?: string;
}

const DEFAULT_LIMIT = 30;

export function globalSearchSync(
  query: string,
  options?: SearchOptions,
): SearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const state = ensureWorkspaceStateSync(options?.workspaceId);
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const types = options?.types ?? ["message", "document", "task", "agent", "skill", "knowledge"];
  const results: SearchResult[] = [];

  if (types.includes("message")) {
    results.push(...searchMessages(state, trimmed, options?.channelName));
  }
  if (types.includes("document")) {
    results.push(...searchDocuments(state, trimmed, options?.channelName));
  }
  if (types.includes("task")) {
    results.push(...searchTasks(state, trimmed));
  }
  if (types.includes("agent")) {
    results.push(...searchAgents(state, trimmed));
  }
  if (types.includes("skill")) {
    results.push(...searchSkills(state, trimmed, options?.workspaceId));
  }
  if (types.includes("knowledge")) {
    results.push(...searchKnowledge(state, trimmed, options?.assignedAgentName, options?.workspaceId));
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function searchMessages(
  state: DofeAgentState,
  query: string,
  channelName?: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  return state.messages
    .filter((message) => {
      if (channelName && message.channel !== channelName) {
        return false;
      }
      if (message.kind === "process") {
        return false;
      }
      const text = message.summary.toLocaleLowerCase("zh-CN");
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, 50)
    .map((message) => ({
      type: "message" as const,
      id: message.id,
      title: `${message.speaker} ${message.channel ? `#${message.channel}` : ""}`,
      snippet: message.summary.slice(0, 120),
      score: computeScore(message.summary, tokens),
      meta: {
        channel: message.channel ?? "",
        speaker: message.speaker,
        time: message.time,
      },
    }));
}

function searchDocuments(
  state: DofeAgentState,
  query: string,
  channelName?: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);
  const versionsByDocId = new Map<string, ChannelDocumentVersion>();
  for (const version of state.channelDocumentVersions) {
    const existing = versionsByDocId.get(version.documentId);
    if (!existing || new Date(version.createdAt) > new Date(existing.createdAt)) {
      versionsByDocId.set(version.documentId, version);
    }
  }

  return state.channelDocuments
    .filter((doc) => {
      if (doc.status !== "active") {
        return false;
      }
      if (channelName && doc.channelName !== channelName) {
        return false;
      }
      const titleMatch = tokens.every((token) =>
        doc.title.toLocaleLowerCase("zh-CN").includes(token),
      );
      if (titleMatch) {
        return true;
      }
      const version = versionsByDocId.get(doc.id);
      if (version) {
        return tokens.every((token) =>
          version.contentMarkdown.toLocaleLowerCase("zh-CN").includes(token),
        );
      }
      return false;
    })
    .slice(0, 20)
    .map((doc) => {
      const version = versionsByDocId.get(doc.id);
      const snippet = version?.contentMarkdown.slice(0, 120) ?? doc.summary;
      return {
        type: "document" as const,
        id: doc.id,
        title: doc.title,
        snippet,
        score: computeScore(doc.title, tokens) + 0.5,
        meta: {
          channel: doc.channelName,
          updatedAt: doc.updatedAt,
        },
      };
    });
}

function searchTasks(
  state: DofeAgentState,
  query: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  return state.tasks
    .filter((task) => {
      const text = `${task.title} ${task.assignee} ${task.channel}`.toLocaleLowerCase("zh-CN");
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, 20)
    .map((task) => ({
      type: "task" as const,
      id: task.id,
      title: task.title,
      snippet: `${task.assignee} · ${task.channel} · ${task.status}`,
      score: computeScore(task.title, tokens) + 0.3,
      meta: {
        assignee: task.assignee,
        channel: task.channel,
        status: task.status,
        priority: task.priority,
      },
    }));
}

function searchAgents(
  state: DofeAgentState,
  query: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  return state.activeEmployees
    .filter((employee) => {
      const text = `${employee.name} ${employee.remarkName ?? ""} ${employee.role} ${employee.summary}`.toLocaleLowerCase("zh-CN");
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, 20)
    .map((employee) => ({
      type: "agent" as const,
      id: employee.name,
      title: employee.remarkName?.trim() || employee.name,
      snippet: employee.summary.slice(0, 120),
      score: computeScore(employee.name, tokens) + 0.8,
      meta: {
        internalName: employee.name,
        role: employee.role,
      },
    }));
}

function searchSkills(
  _state: DofeAgentState,
  query: string,
  workspaceId?: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  return listWorkspaceSkillsSync(workspaceId)
    .filter((skill) => {
      const text = `${skill.name} ${skill.description}`.toLocaleLowerCase("zh-CN");
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, 20)
    .map((skill) => ({
      type: "skill" as const,
      id: skill.id,
      title: skill.name,
      snippet: skill.description.slice(0, 120),
      score: computeScore(skill.name, tokens) + 0.4,
      meta: {},
    }));
}

function searchKnowledge(
  state: DofeAgentState,
  query: string,
  assignedAgentName?: string,
  workspaceId?: string,
): SearchResult[] {
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);

  const allowedPageIds = assignedAgentName
    ? new Set(listEmployeeKnowledgePageIdsSync(assignedAgentName, workspaceId))
    : undefined;

  return state.knowledgePages
    .filter((page) => {
      if (allowedPageIds && !allowedPageIds.has(page.id)) {
        return false;
      }
      const text = `${page.title} ${page.contentMarkdown} ${page.tags.join(" ")}`.toLocaleLowerCase("zh-CN");
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, 20)
    .map((page) => ({
      type: "knowledge" as const,
      id: page.id,
      title: page.title,
      snippet: page.contentMarkdown.slice(0, 120) || "(empty page)",
      score: computeScore(page.title, tokens) + 0.6,
      meta: {
        tags: page.tags.join(", "),
        updatedAt: page.updatedAt,
      },
    }));
}

function computeScore(text: string, tokens: string[]): number {
  const lower = text.toLocaleLowerCase("zh-CN");
  let score = 0;
  for (const token of tokens) {
    if (lower.startsWith(token)) {
      score += 3;
    } else if (lower.includes(token)) {
      score += 1;
    }
  }
  return score / Math.max(tokens.length, 1);
}
