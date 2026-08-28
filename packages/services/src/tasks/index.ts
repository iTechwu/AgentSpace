// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/tasks` 子路径与根 re-export 使用。

export {
  listTasksSync,
  createTaskSync,
  updateTaskStatusSync,
  reorderTaskSync,
  addTaskLabelSync,
  removeTaskLabelSync,
} from "./tasks.ts";

export {
  recordTaskExecutionEventSync,
  listTaskExecutionEventsSync,
  listTaskExecutionEventsAsync,
  type TaskExecutionEventInput,
  type TaskExecutionEventListOptions,
  type TaskExecutionEventRecord,
} from "../task-execution-events.ts";

export {
  listApprovalsSync,
  createApprovalRequestSync,
  createRuntimeToolApprovalRequestSync,
  reviewApprovalSync,
} from "../approvals/approvals.ts";
