// 任务队列与执行事件（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


export type NativeTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "preparing_commit"
  | "committed"
  | "completed"
  | "failed"
  | "cancelled";
export const TASK_EXECUTION_EVENT_TYPES = [
  "queued",
  "assigned",
  "workspace_prepared",
  "context_loaded",
  "tool_started",
  "tool_finished",
  "artifact_detected",
  "artifact_collected",
  "approval_requested",
  "approval_reviewed",
  "blocked",
  "handoff_created",
  "message_posted",
  "commit_preparing",
  "commit_committed",
  "commit_failed",
  "recovery_started",
  "recovery_completed",
  "recovery_failed",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskExecutionEventType = typeof TASK_EXECUTION_EVENT_TYPES[number];
export type TaskExecutionEventSeverity = "info" | "warning" | "error";
export type TaskExecutionEventStatus = "pending" | "running" | "succeeded" | "failed";

export interface QueuedTaskRecord {
  id: string;
  workspaceId: string;
  /** Stable employee identity used for authorization, attribution and fencing. */
  employeeId: string;
  /** Display-name snapshot captured when the task was queued. */
  employeeName: string;
  /** @deprecated Legacy display-name field. Use employeeId for identity. */
  agentId: string;
  runtimeId: string;
  /** Runtime credential captured when the task is claimed; immutable for billing attribution. */
  runtimeCredentialId?: string;
  routerSessionId?: string;
  /** 多会话拆分：所属 Conversation 的不可变身份。 */
  conversationId?: string;
  /** 多会话拆分：所属 Execution Lane（conversation + employee 的有序执行边界）。 */
  executionLaneId?: string;
  issueId?: string;
  triggerType: string;
  priority: number;
  status: NativeTaskStatus;
  inputJson: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  resultJson?: string;
  errorText?: string;
  sessionId?: string;
  workDir?: string;
  bindingGeneration?: number;
  queuedAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  mcpSessionClaimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessageRecord {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  tool?: string;
  content?: string;
  inputJson?: string;
  output?: string;
  /** Correlates a tool_result with its tool_use (provider-side call id). */
  refId?: string;
  createdAt: string;
}

export interface TaskExecutionEventRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  channelName: string;
  agentId: string;
  runtimeId?: string;
  runId?: string;
  type: TaskExecutionEventType;
  title: string;
  summary?: string;
  severity: TaskExecutionEventSeverity;
  status?: TaskExecutionEventStatus;
  dataJson: string;
  createdAt: string;
}

export interface EnqueueTaskInput {
  workspaceId?: string;
  /** Optional deterministic clock used by transactional shadow comparisons. */
  now?: string;
  /** Stable operation key for retry-safe queue creation. */
  idempotencyKey?: string;
  taskId?: string;
  assignee: string;
  title: string;
  channel?: string;
  priority: "low" | "medium" | "high";
  triggerType?: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  /** 多会话拆分：chat trigger 写入的会话身份与执行泳道。 */
  conversationId?: string;
  executionLaneId?: string;
  metadata?: Record<string, unknown>;
  workflow?: WorkflowTaskMetadata;
}

export interface WorkflowTaskMetadata {
  workflowId: string;
  workflowVersionId: string;
  workflowRunId: string;
  workflowNodeId: string;
  workflowNodeRunId: string;
  attempt: number;
  artifactRefs: string[];
  outputSchema?: Record<string, unknown>;
}

export function isNativeTaskStatus(value: unknown): value is NativeTaskStatus {
  return (
    value === "queued" ||
    value === "claimed" ||
    value === "running" ||
    value === "preparing_commit" ||
    value === "committed" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export function isTaskExecutionEventType(value: unknown): value is TaskExecutionEventType {
  return typeof value === "string" && TASK_EXECUTION_EVENT_TYPES.includes(value as TaskExecutionEventType);
}

export function isTaskExecutionEventSeverity(value: unknown): value is TaskExecutionEventSeverity {
  return value === "info" || value === "warning" || value === "error";
}

export function isTaskExecutionEventStatus(value: unknown): value is TaskExecutionEventStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed";
}
