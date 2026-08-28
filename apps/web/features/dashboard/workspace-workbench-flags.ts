import type { WorkspaceModuleId } from "@/features/dashboard/workspace-module-route";

const WORKSPACE_MODULE_CLIENT_FLAG_NAMES = {
  agents: "NEXT_PUBLIC_WORKSPACE_MODULE_AGENTS_CLIENT_ENABLED",
  approvals: "NEXT_PUBLIC_WORKSPACE_MODULE_APPROVALS_CLIENT_ENABLED",
  automations: "NEXT_PUBLIC_WORKSPACE_MODULE_AUTOMATIONS_CLIENT_ENABLED",
  calendar: "NEXT_PUBLIC_WORKSPACE_MODULE_CALENDAR_CLIENT_ENABLED",
  contacts: "NEXT_PUBLIC_WORKSPACE_MODULE_CONTACTS_CLIENT_ENABLED",
  costs: "NEXT_PUBLIC_WORKSPACE_MODULE_COSTS_CLIENT_ENABLED",
  im: "NEXT_PUBLIC_WORKSPACE_MODULE_IM_CLIENT_ENABLED",
  inbox: "NEXT_PUBLIC_WORKSPACE_MODULE_INBOX_CLIENT_ENABLED",
  knowledge: "NEXT_PUBLIC_WORKSPACE_MODULE_KNOWLEDGE_CLIENT_ENABLED",
  market: "NEXT_PUBLIC_WORKSPACE_MODULE_MARKET_CLIENT_ENABLED",
  "org-chart": "NEXT_PUBLIC_WORKSPACE_MODULE_ORG_CHART_CLIENT_ENABLED",
  performance: "NEXT_PUBLIC_WORKSPACE_MODULE_PERFORMANCE_CLIENT_ENABLED",
  settings: "NEXT_PUBLIC_WORKSPACE_MODULE_SETTINGS_CLIENT_ENABLED",
  skills: "NEXT_PUBLIC_WORKSPACE_MODULE_SKILLS_CLIENT_ENABLED",
  tables: "NEXT_PUBLIC_WORKSPACE_MODULE_TABLES_CLIENT_ENABLED",
  "task-board": "NEXT_PUBLIC_WORKSPACE_MODULE_TASK_BOARD_CLIENT_ENABLED",
  templates: "NEXT_PUBLIC_WORKSPACE_MODULE_TEMPLATES_CLIENT_ENABLED",
} as const satisfies Record<WorkspaceModuleId, string>;

export function isWorkspaceClientWorkbenchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WORKSPACE_CLIENT_WORKBENCH_ENABLED !== "0";
}

export function isWorkspaceModuleCacheEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WORKSPACE_MODULE_CACHE_ENABLED !== "0";
}

export function canUseWorkspaceClientWorkbench(): boolean {
  return isWorkspaceClientWorkbenchEnabled() && isWorkspaceModuleCacheEnabled();
}

export function canUseWorkspaceClientModule(moduleId: WorkspaceModuleId | null): moduleId is WorkspaceModuleId {
  if (!moduleId || !canUseWorkspaceClientWorkbench()) {
    return false;
  }

  const flagName = WORKSPACE_MODULE_CLIENT_FLAG_NAMES[moduleId];
  return process.env[flagName] !== "0";
}

export function getWorkspaceModuleClientFlagName(moduleId: WorkspaceModuleId): string {
  return WORKSPACE_MODULE_CLIENT_FLAG_NAMES[moduleId];
}
