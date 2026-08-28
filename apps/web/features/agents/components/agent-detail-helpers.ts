// AgentDetail 的纯函数集（从 agent-detail.tsx 拆出，3.4-2）：
// codex 策略映射、skill 声明解析与状态文案、provider 健康文案、
// 文档角色/申请状态文案、工作区时间与位置格式化。无 React 依赖。

import type { RouterExecutionView, WorkspaceAgentRecord } from "@/features/dashboard/data";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";
import type { SkillPickerRequirementStatus } from "@/features/agents/components/skill-picker-modal";
import { formatCompactTimestamp } from "@/shared/lib/time-format";

export function codexPolicySelection(policy: EmployeeExecutionPolicy | undefined): "inherit" | "untrusted" | "on-request" | "full-access" {
  if (!policy?.codexApprovalPolicy && !policy?.codexSandboxMode) {
    return "inherit";
  }
  if (policy?.codexSandboxMode === "danger-full-access" || policy?.codexApprovalPolicy === "never") {
    return "full-access";
  }
  return policy?.codexApprovalPolicy === "on-request" ? "on-request" : "untrusted";
}

export function codexPolicyFromSelection(value: string): EmployeeExecutionPolicy | undefined {
  if (value === "inherit") {
    return undefined;
  }
  if (value === "full-access") {
    return { codexApprovalPolicy: "never", codexSandboxMode: "danger-full-access" };
  }
  return {
    codexApprovalPolicy: value === "on-request" ? "on-request" : "untrusted",
    codexSandboxMode: "workspace-write",
  };
}

export function hasInstallRequirements(configJson: string | undefined): boolean {
  try {
    const requirements = (JSON.parse(configJson ?? "{}") as { requirements?: unknown }).requirements;
    return Array.isArray(requirements) && requirements.length > 0;
  } catch {
    return false;
  }
}

function skillRequirementPreview(configJson: string | undefined): { requiredCount: number; providers: string[] } {
  try {
    const requirements = (JSON.parse(configJson ?? "{}") as { requirements?: unknown }).requirements;
    if (!Array.isArray(requirements)) {
      return { requiredCount: 0, providers: [] };
    }
    const items = requirements.filter((item): item is { kind?: string; value?: string } => (
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    ));
    return {
      requiredCount: items.filter((item) => item.kind === "config" || item.kind === "secret").length,
      providers: items.filter((item) => item.kind === "provider").map((item) => item.value ?? "").filter(Boolean),
    };
  } catch {
    return { requiredCount: 0, providers: [] };
  }
}

export function formatSkillPickerRequirementStatus(
  skill: WorkspaceSkill,
  boundProvider: string | undefined,
  tx: (zh: string, en: string) => string,
): SkillPickerRequirementStatus | undefined {
  const { requiredCount, providers } = skillRequirementPreview(skill.configJson);
  if (providers.length > 0 && boundProvider && !providers.includes(boundProvider)) {
    return { tone: "danger", label: tx("运行环境不兼容", "Runtime incompatible") };
  }
  if (requiredCount === 0) {
    return { tone: "positive", label: tx("就绪，可安装", "Ready to install") };
  }
  return { tone: "warning", label: tx(`需配置 ${requiredCount} 项`, `Needs ${requiredCount} item(s) configured`) };
}

const AUTH_ERROR_PATTERN = /(^|\W)(auth|unauthor|forbidden|401|403|token|secret|api[_-]?key|credential|expired|invalid[_ ]?key)(\W|$)/i;
export function isLikelyAuthError(errorText: string | undefined): boolean {
  return Boolean(errorText) && AUTH_ERROR_PATTERN.test(errorText ?? "");
}

export function skillRequirementStatusTone(
  status: WorkspaceAgentRecord["skillRequirements"][string]["status"],
): "positive" | "warning" | "danger" {
  if (status === "ready") return "positive";
  if (status === "runtime_incompatible") return "danger";
  return "warning";
}

export function dependencyStatusTone(
  status: WorkspaceAgentRecord["skillRequirements"][string]["dependencyInstallStatus"],
): "positive" | "warning" | "danger" {
  if (status === "ok") return "positive";
  if (status === "failed") return "danger";
  return "warning";
}

export function formatDependencyStatus(
  status: WorkspaceAgentRecord["skillRequirements"][string]["dependencyInstallStatus"],
  tx: (zh: string, en: string) => string,
): string | null {
  if (!status) return null;
  switch (status) {
    case "ok":
      return null; // ready deps don't need a chip
    case "failed":
      return tx("依赖安装失败", "Dependency install failed");
    case "installing":
      return tx("依赖安装中", "Installing dependencies");
    case "pending":
      return tx("依赖待安装", "Dependencies pending install");
    case "waiting_runtime":
      return tx("等待执行引擎后安装依赖", "Dependencies install after runtime bind");
    default:
      return null;
  }
}

export function formatSkillRequirementStatus(
  summary: WorkspaceAgentRecord["skillRequirements"][string],
  tx: (zh: string, en: string) => string,
): string {
  if (summary.status === "expired") {
    const added = summary.upgradeAddedKeys?.length ?? 1;
    const removed = summary.upgradeRemovedKeys?.length ?? 0;
    return removed > 0
      ? tx(`已过期 · 新增 ${added} 项、移除 ${removed} 项要求`, `Expired · ${added} added, ${removed} removed`)
      : tx(`已过期 · 新增 ${added} 项要求`, `Expired · ${added} new requirement(s)`);
  }
  if (summary.status === "awaiting_validation") {
    return tx("等待验证 · Runtime 离线", "Awaiting validation · runtime offline");
  }
  if (summary.status === "runtime_incompatible") {
    return tx("Runtime 不兼容", "Runtime incompatible");
  }
  if (summary.status === "needs_configuration") {
    if (summary.configuredCount >= summary.requiredCount) {
      return tx("安装检查未通过", "Installation check incomplete");
    }
    return tx(
      `需配置 · ${summary.configuredCount}/${summary.requiredCount} 环境变量`,
      `Needs configuration · ${summary.configuredCount}/${summary.requiredCount} environment variables`,
    );
  }
  if (summary.requiredCount === 0) {
    return tx("已就绪", "Ready");
  }
  return tx(
    `已就绪 · ${summary.configuredCount}/${summary.requiredCount} 环境变量`,
    `Ready · ${summary.configuredCount}/${summary.requiredCount} environment variables`,
  );
}

export function translateSkillSourceLabel(
  skill: WorkspaceAgentRecord["skills"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (skill.sourceType === "builtin") {
    return tx("系统默认技能", "System default skill");
  }
  if (skill.sourceType === "github") {
    return tx("来自 GitHub 导入", "Imported from GitHub");
  }
  if (skill.sourceType === "gitlab") {
    return tx("来自 GitLab 导入", "Imported from GitLab");
  }
  if (skill.sourceType === "skills.sh") {
    return tx("来自 skills.sh 导入", "Imported from skills.sh");
  }
  if (skill.sourceType === "clawhub") {
    return tx("来自 ClawHub 导入", "Imported from ClawHub");
  }
  if (skill.sourceType === "local") {
    return tx("来自本地导入", "Imported from local files");
  }
  return tx("手动创建", "Created manually");
}

export function formatProviderUsability(
  health: NonNullable<WorkspaceAgentRecord["boundProviderHealth"]>,
  tx: (zh: string, en: string) => string,
): string {
  if (health.providerUsable === "usable") {
    return health.providerHealth === "degraded" ? tx("降级可用", "Degraded") : tx("可用", "Available");
  }
  if (health.providerUsable === "unusable") {
    return tx("不可用", "Unavailable");
  }
  return tx("未验证", "Unverified");
}

export function providerUsabilityStatusTone(
  health: NonNullable<WorkspaceAgentRecord["boundProviderHealth"]>,
): "positive" | "warning" | "danger" | "neutral" {
  if (health.providerUsable === "usable") {
    return health.providerHealth === "degraded" ? "warning" : "positive";
  }
  if (health.providerUsable === "unusable") {
    return "danger";
  }
  return "neutral";
}

export function formatProviderError(health: NonNullable<WorkspaceAgentRecord["boundProviderHealth"]>): string {
  return [
    health.lastProviderErrorCode,
    health.lastProviderErrorMessage ?? health.providerHealthReason,
  ].filter(Boolean).join(" · ");
}

export function formatAgentDocumentRole(
  role: "viewer" | "editor" | "forwarder",
  tx: (zh: string, en: string) => string,
): string {
  if (role === "forwarder") {
    return tx("可转发", "Forwarder");
  }
  if (role === "editor") {
    return tx("可编辑", "Editor");
  }
  return tx("可查看", "Viewer");
}

export function agentDocumentRoleTone(role: "viewer" | "editor" | "forwarder"): "positive" | "warning" | "danger" | "neutral" {
  if (role === "forwarder") {
    return "positive";
  }
  if (role === "editor") {
    return "warning";
  }
  return "neutral";
}

export function formatDocumentRequestStatus(
  status: "pending" | "approved" | "rejected" | "cancelled",
  tx: (zh: string, en: string) => string,
): string {
  if (status === "pending") {
    return tx("待审批", "Pending");
  }
  if (status === "approved") {
    return tx("已批准", "Approved");
  }
  if (status === "rejected") {
    return tx("已拒绝", "Rejected");
  }
  return tx("已取消", "Cancelled");
}

export function documentRequestStatusTone(
  status: "pending" | "approved" | "rejected" | "cancelled",
): "positive" | "warning" | "danger" | "neutral" {
  if (status === "approved") {
    return "positive";
  }
  if (status === "pending") {
    return "warning";
  }
  if (status === "rejected") {
    return "danger";
  }
  return "neutral";
}

export function formatAgentTimestamp(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}

export function translateContinuationMode(
  mode: RouterExecutionView["continuationMode"],
  tx: (zh: string, en: string) => string,
): string {
  if (mode === "same_provider_resume") return tx("同 provider 续跑", "Same-provider resume");
  if (mode === "fallback") return tx("Fallback 冷重建", "Fallback cold rebuild");
  return tx("平台上下文冷重建", "Platform cold rebuild");
}

export function renderWorkAreaLocation(
  area: {
    workDir?: string;
    workDirAccess?: "local" | "remote";
    workDirHostLabel?: string;
  },
  tx: (zh: string, en: string) => string,
): string {
  if (area.workDirAccess === "remote") {
    const hostLabel = area.workDirHostLabel ?? tx("远程宿主", "Remote host");
    return tx(`远程执行工作区: ${hostLabel} · 路径仅供诊断`, `Remote execution workspace: ${hostLabel} · path shown for diagnostics only`);
  }

  return tx(`执行工作区: ${area.workDir ?? tx("未返回", "Unavailable")}`, `Execution workspace: ${area.workDir ?? tx("未返回", "Unavailable")}`);
}
