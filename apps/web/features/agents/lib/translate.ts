import type { ContainerRecord, WorkspaceAgentRecord } from "@/features/dashboard/data";

type TranslateFn = (zh: string, en: string) => string;

export function toneForStatus(
  status: WorkspaceAgentRecord["status"] | ContainerRecord["status"],
): "neutral" | "positive" | "warning" | "danger" {
  if (status === "error" || status === "blocked") return "danger";
  if (status === "busy") return "warning";
  if (status === "linked" || status === "online") return "positive";
  return "neutral";
}

export function translateManagementStatus(value: string, tx: TranslateFn): string {
  if (value === "busy") return tx("处理中", "Working");
  if (value === "blocked") return tx("阻塞", "Blocked");
  if (value === "linked") return tx("已连接", "Connected");
  if (value === "error") return tx("异常", "Error");
  if (value === "online") return tx("在线", "Online");
  if (value === "处理中") return tx("处理中", "Working");
  if (value === "阻塞") return tx("阻塞", "Blocked");
  if (value === "已连接") return tx("已连接", "Connected");
  if (value === "异常") return tx("异常", "Error");
  if (value === "在线") return tx("在线", "Online");
  return value;
}

export function translateQueueValue(value: string, tx: TranslateFn): string {
  if (value === "not_queued") return tx("未入队", "Not queued");
  if (value === "queued") return tx("已入队", "Queued");
  if (value === "claimed") return tx("已认领", "Claimed");
  if (value === "running") return tx("执行中", "Running");
  if (value === "completed") return tx("已完成", "Completed");
  if (value === "failed") return tx("执行失败", "Failed");
  if (value === "cancelled") return tx("已取消", "Cancelled");
  if (value === "未入队") return tx("未入队", "Not queued");
  if (value === "已入队") return tx("已入队", "Queued");
  if (value === "已认领") return tx("已认领", "Claimed");
  if (value === "执行中") return tx("执行中", "Running");
  if (value === "已完成") return tx("已完成", "Completed");
  if (value === "执行失败") return tx("执行失败", "Failed");
  if (value === "已取消") return tx("已取消", "Cancelled");
  return value;
}

export function translateTaskStatusValue(value: string, tx: TranslateFn): string {
  if (value === "todo") return tx("待开始", "Todo");
  if (value === "in_progress") return tx("进行中", "In progress");
  if (value === "blocked") return tx("已阻塞", "Blocked");
  if (value === "done") return tx("已完成", "Done");
  return value;
}

export function translatePriorityValue(value: string, tx: TranslateFn): string {
  if (value === "high") return tx("高优先级", "High");
  if (value === "medium") return tx("中优先级", "Medium");
  if (value === "low") return tx("低优先级", "Low");
  return value;
}

export function translateContainerDescription(value: string, tx: TranslateFn): string {
  if (value === "容器已在线，可承载多个 AI员工 的独立工作区域。") {
    return tx("容器已在线，可承载多个 AI员工 的独立工作区域。", "The container is online and can host independent work areas for multiple AI employees.");
  }
  if (value === "The container is online and can host independent work areas for multiple agents.") {
    return tx("容器已在线，可承载多个 AI员工 的独立工作区域。", value);
  }
  if (value === "容器当前离线。") {
    return tx("容器当前离线。", "The container is currently offline.");
  }
  if (value === "The container is currently offline.") {
    return tx("执行引擎当前离线。", value);
  }
  if (value && /[A-Za-z]/.test(value)) {
    return tx("执行引擎已接入，可为多个 AI员工 提供独立的任务执行环境。", value);
  }
  return value;
}
