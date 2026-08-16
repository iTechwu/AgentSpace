// 共享类型入口（3.2-4 拆分后 barrel）：全部类型按域下沉到 ./types/，
// 这里维持既有导入面 `from "../types.ts"` 不变。
export * from "./types/identity.ts";
export * from "./types/integrations.ts";
export * from "./types/runtime.ts";
export * from "./types/audit.ts";
export * from "./types/employee-runtime.ts";
export * from "./types/documents.ts";
export * from "./types/agent-access.ts";
export * from "./types/knowledge.ts";
export * from "./types/notifications.ts";
export * from "./types/agent-forks.ts";
export * from "./types/runtime-apps.ts";
export * from "./types/mcp.ts";
export * from "./types/skills.ts";
export * from "./types/channels.ts";
export * from "./types/tasks.ts";
export * from "./types/token-usage.ts";
export * from "./types/skill-installations.ts";
export * from "./types/employee-durability.ts";
export * from "./types/workflow.ts";
export * from "./types/capability.ts";
