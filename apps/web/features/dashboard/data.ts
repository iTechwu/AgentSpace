// Workspace dashboard 各页面数据装配入口（拆分后收敛为 barrel）：各域 loader 见 ./data/ 子模块，
// 类型定义在 ./data-types.ts，共享视图 helper 在 ./dashboard-view-builders.ts。
// 公共导出面与拆分前一致，57 个引用方零改动。
export type {
  AgentKnowledgePageRecord,
  AgentWorkAreaRecord,
  AgentsPageData,
  ChannelDetailPageData,
  ChannelDocumentAccessRecord,
  ChannelDocumentChangeSetRecord,
  ChannelDocumentCollaboratorCandidateRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentPresenceRecord,
  ChannelDocumentRecord,
  ChannelDocumentRunRecord,
  ChannelDocumentSyncEventRecord,
  ChannelDocumentVersionRecord,
  ChannelFeishuSummaryRecord,
  ChannelFileRecord,
  ChannelListItem,
  ChannelThreadData,
  ChannelsPageData,
  CliHubReadinessRecord,
  ContactListItem,
  ContainerRecord,
  DaemonSnapshotView,
  DaemonTokenView,
  DashboardCurrentUser,
  DigitalEmployeeShowcaseAgentRecord,
  InboxItem,
  InboxItemKind,
  InboxPageData,
  InboxTimelineEntry,
  KnowledgeAgentOption,
  KnowledgeAssignedAgentRecord,
  KnowledgeAssignmentStats,
  KnowledgeDocumentPageRecord,
  KnowledgePageRecord,
  ManagementRecordBase,
  ProviderAccountView,
  ReadinessItemView,
  RouterExecutionAttemptView,
  RouterExecutionView,
  RouterProviderSessionView,
  RuntimeAppOperationView,
  RuntimeGrantMember,
  RuntimeInstalledAppView,
  RuntimeMcpConnectionView,
  RuntimeProvisionRequestView,
  SkillsPageData,
  TaskExecutionTimelineAction,
  TaskExecutionTimelineCategory,
  TaskExecutionTimelineEntry,
  WorkspaceAgentAccessRequestView,
  WorkspaceAgentDocumentAccessRecord,
  WorkspaceAgentDocumentAccessSummaryRecord,
  WorkspaceAgentDocumentPermissionRequestRecord,
  WorkspaceAgentForkInvitationView,
  WorkspaceAgentKnowledgeRecord,
  WorkspaceAgentRecord,
  WorkspaceAgentStatus,
} from "./data-types";
export {
  getApprovalsPageData,
  getPendingApprovalCount,
  type ApprovalItem,
  type ApprovalItemKind,
  type ApprovalItemStatus,
  type ApprovalQueueActor,
  type ApprovalsPageData,
} from "@/features/approvals/approval-queue-data";

export { redactSkillRequirementsForViewer } from "./data/agent-record.ts";
export { getAgentsPageData } from "./data/agents.ts";
export { getChannelDetailData, getChannelListPageData, getChannelsPageData } from "./data/channels.ts";
export { getBudgetPageData, getCostPageData, getCostPageDataAsync } from "./data/cost.ts";
export { getAgentsPageDataAsync, getInboxPageData, getInboxPageDataAsync, replaceInboxNotificationItems } from "./data/inbox.ts";
export { getKnowledgePageData } from "./data/knowledge.ts";
export { getAutomationsPageData, getCalendarPageData, getDataTablesPageData, getPerformancePageData, getTemplatesPageData } from "./data/misc-pages.ts";
export { getOrgChartPageData, readAuthenticatedUserCountSync } from "./data/org-chart.ts";
export { listDaemonSnapshotViews, listDaemonTokenViews, listProviderAccountViews, listRuntimeProvisionRequestViews } from "./data/runtime-views.ts";
export { getSkillsPageData, getSkillsPageDataAsync } from "./data/skills.ts";
export { getTaskBoardPageData } from "./data/task-board.ts";
export type { BudgetPageData, BudgetPageItem, CostPageData } from "./data/cost.ts";
export type { KnowledgePageData, KnowledgeParseTask } from "./data/knowledge.ts";
export type { AutoContinuationRunRecord, AutomationsPageData, CalendarPageData, DataTablesPageData, TemplatesPageData } from "./data/misc-pages.ts";
export type { OrgChartNode, OrgChartPageData } from "./data/org-chart.ts";
export type { TaskBoardColumn, TaskBoardGroupBy, TaskBoardPageData } from "./data/task-board.ts";
