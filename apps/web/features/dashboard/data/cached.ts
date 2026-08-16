// dashboard cache 包裹的共享读取器与数量常量（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { listAgentRouterProviderSessionsSync, listAgentTaskAttemptsSync, listDaemonApiTokensSync, listDaemonSnapshotsSync, listEmployeeRuntimeBindingsSync, listMcpCatalogItemsSync, listMcpConnectionsSync, listProviderAccountsSync, listQueuedTasksSync, listRuntimeAppOperationsSync, listRuntimeGrantsSync, listRuntimeInstalledAppsSync, listRuntimeProvisionRequestsSync, listStoredSkillImportEventsSync, listTaskExecutionEventsSync, listWorkspaceRuntimeDisplayNamesSync, readAgentRouterSessionSync } from "@dofe-agent/db";
import type { BudgetPeriod } from "@dofe-agent/db";
import { getCostDashboardDataAsync, getCostDashboardDataSync, getPerformanceDashboardData, listBudgetsWithSpentSync, listKnowledgeAssignmentPoliciesSync, listKnowledgeAssignmentsSync, listWorkspaceSkillsSync, readWorkspaceStateSnapshotSync } from "@dofe-agent/services";
import { cache } from "react";

export const readWorkspaceStateCached = cache((workspaceId: string) => readWorkspaceStateSnapshotSync(workspaceId));
export const listWorkspaceSkillsCached = cache((workspaceId: string) => listWorkspaceSkillsSync(workspaceId));
export const listKnowledgeAssignmentPoliciesCached = cache((workspaceId: string) => listKnowledgeAssignmentPoliciesSync(workspaceId));
export const listKnowledgeAssignmentsCached = cache((workspaceId: string) => listKnowledgeAssignmentsSync(workspaceId));
export const listDaemonSnapshotsCached = cache((workspaceId: string) => listDaemonSnapshotsSync(workspaceId));
export const listEmployeeRuntimeBindingsCached = cache((workspaceId: string) => listEmployeeRuntimeBindingsSync(workspaceId));
export const listQueuedTasksCached = cache((workspaceId: string) => listQueuedTasksSync({ workspaceId }));
export const readAgentRouterSessionCached = cache((routerSessionId: string) => readAgentRouterSessionSync(routerSessionId));
export const listAgentTaskAttemptsCached = cache((workspaceId: string, taskQueueId: string) =>
  listAgentTaskAttemptsSync({ workspaceId, taskQueueId, limit: 20 })
);
export const listAgentRouterProviderSessionsCached = cache((workspaceId: string, routerSessionId: string) =>
  listAgentRouterProviderSessionsSync({ workspaceId, routerSessionId })
);
export const listRuntimeInstalledAppsCached = cache((workspaceId: string) => listRuntimeInstalledAppsSync({ workspaceId }));
export const listRuntimeAppOperationsCached = cache((workspaceId: string, limit: number) => listRuntimeAppOperationsSync({ workspaceId, limit }));
export const listMcpConnectionsCached = cache((workspaceId: string) => listMcpConnectionsSync({ workspaceId, limit: 500 }));
export const listMcpCatalogItemsCached = cache((workspaceId: string) => listMcpCatalogItemsSync({ workspaceId, limit: 500 }));
export const listTaskExecutionEventsCached = cache((workspaceId: string, taskId: string, limit: number) =>
  listTaskExecutionEventsSync({ workspaceId, taskId, limit, order: "asc" })
);
export const listRuntimeGrantsCached = cache((workspaceId: string) => listRuntimeGrantsSync(workspaceId));
export const listWorkspaceRuntimeDisplayNamesCached = cache((workspaceId: string) =>
  listWorkspaceRuntimeDisplayNamesSync(workspaceId)
);
export const listDaemonApiTokensCached = cache((workspaceId: string) => listDaemonApiTokensSync(workspaceId));
export const listProviderAccountsCached = cache((workspaceId: string) => listProviderAccountsSync(workspaceId));
export const listRuntimeProvisionRequestsCached = cache((workspaceId: string) => listRuntimeProvisionRequestsSync(workspaceId));
export const listStoredSkillImportEventsCached = cache((workspaceId: string, limit: number) => listStoredSkillImportEventsSync(workspaceId, limit));
export const getCostDashboardDataCached = cache((period: BudgetPeriod, workspaceId: string) => getCostDashboardDataSync(period, workspaceId));
export const getAuthoritativeCostDashboardDataCached = cache((period: BudgetPeriod, workspaceId: string) => getCostDashboardDataAsync(period, workspaceId));
export const listBudgetsWithSpentCached = cache((workspaceId: string) => listBudgetsWithSpentSync(workspaceId));
export const getPerformanceDashboardDataCached = cache((workspaceId: string) => getPerformanceDashboardData(workspaceId));
export const INBOX_TASK_ITEM_LIMIT = 60;
export const TASK_BOARD_TASK_LIMIT = 180;
export const AGENT_TASK_PREVIEW_LIMIT = 12;
export const AGENT_KNOWLEDGE_PREVIEW_LIMIT = 20;
export const AGENT_ASSIGNABLE_KNOWLEDGE_LIMIT = 120;
export const KNOWLEDGE_PAGE_PREVIEW_LIMIT = 120;
