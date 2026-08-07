import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";

/**
 * 工作流状态 → 共享 AppIcon 图标名（UIUX:91：状态须同时有文字、图标和 aria-label）。
 *
 * 这是运行级状态（created/running/succeeded…）与节点级状态（pending/ready/retry_wait…）
 * 的单一图标来源，供页头、列表、流程图复用，避免各视图各自维护一份映射导致字形不一致。
 * 图标仅作视觉强化（AppIcon 内部 aria-hidden），可访问的状态由 StatusIndicator 的
 * aria-label + 可见文字提供，不依赖颜色单一表达。
 */
export const WORKFLOW_STATUS_ICON: Record<string, AppIconName> = {
  created: "calendar",
  pending: "loader",
  ready: "loader",
  queued: "loader",
  running: "loader",
  waiting_approval: "approvals",
  paused: "stop",
  retry_wait: "refresh",
  succeeded: "checkCircle",
  partially_succeeded: "checkCircle",
  failed: "alertCircle",
  cancelled: "stop",
  skipped: "close",
};

/**
 * 统一的状态指示器：图标 + 可见文字 + aria-label（UIUX:52/91）。
 *
 * - 渲染共享 AppIcon（aria-hidden）作视觉强化，不依赖颜色单一表达状态；
 * - 容器 aria-label 让读屏一次性朗读完整状态文字，可见文字对健全用户可见；
 * - 保留 data-status 供现有按状态着色的 CSS 选择器继续生效；
 * - className 由调用方传入以匹配各处布局（页头胶囊、节点状态、流程图节点等）。
 */
export function WorkflowStatusIndicator({
  status,
  label,
  className,
}: {
  status: string;
  label: string;
  className?: string;
}) {
  return (
    <span aria-label={label} className={className} data-status={status}>
      <AppIcon className="workflow-status-indicator__icon" name={WORKFLOW_STATUS_ICON[status] ?? "loader"} />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
