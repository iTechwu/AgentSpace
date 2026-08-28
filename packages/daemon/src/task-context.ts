// 3.5-4：原 1544 行单文件按职责拆分至 task-context/ 子模块。本文件保留为
// barrel，显式重导出原有 18 个公共符号；模块间内部依赖
// （resolveAgentNotificationsForTask 等）不在此暴露。
export type { ParsedTaskPayload } from "./task-context/payload.ts";
export {
  parseTaskInputJson,
  parseTaskPayload,
  resolveConversationThreadId,
} from "./task-context/payload.ts";
export type {
  AgentKnowledgePromptContext,
  RouterSessionPromptContext,
} from "./task-context/prompt-lines.ts";
export { buildTaskPrompt, buildTaskPromptWithDocumentContexts } from "./task-context/prompt.ts";
export type { PreparedDaemonTaskContext } from "./task-context/prepare.ts";
export { WorkspaceMaterializationIncompleteError, prepareDaemonTaskContext } from "./task-context/prepare.ts";
export {
  materializeAgentKnowledgePages,
  materializeAgentSkills,
  materializeAttachments,
  resolveAgentKnowledgePages,
} from "./task-context/materialize.ts";
export {
  collectSkillReadinessBlockers,
  resolveAgentSkillEnvironment,
  resolveAgentSkills,
} from "./task-context/skills.ts";
