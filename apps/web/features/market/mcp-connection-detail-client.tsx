"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  disableMcpConnectionAction,
  enableMcpConnectionAction,
  removeMcpConnectionAction,
  reverifyMcpConnectionAction,
} from "@/features/market/mcp-actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { runToastAction, type ActionToastResult } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import type { AppIconName } from "@/shared/ui/app-icon";

export interface McpConnectionDetailPageData {
  workspaceId: string;
  canManage: boolean;
  connection: {
    id: string;
    runtimeId: string;
    runtimeLabel: string;
    catalogItemId: string;
    catalogSlug: string;
    catalogDisplayName: string;
    catalogDescription: string;
    status: string;
    transport: string;
    endpoint: string;
    allowedHosts: string[];
    dataDomains: string[];
    approvedTools: string[];
    declaredTools: Array<{ name: string; description: string; risk: "low" | "medium" | "high" }>;
    nonSecretParams: Record<string, unknown>;
    lastVerifiedAt?: string;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    nextHealthCheckAt?: string;
    healthCheckConsecutiveFailures: number;
  };
  activity: {
    operations: Array<{
      id: string;
      operation: string;
      source: string;
      status: string;
      createdAt: string;
      completedAt?: string;
      errorMessage?: string;
    }>;
    audits: Array<{
      id: string;
      toolName: string;
      outcome: string;
      latencyMs?: number;
      safeSummary?: string;
      createdAt: string;
    }>;
  };
}

type TabId = "overview" | "tools" | "config" | "activity";

export function McpConnectionDetailPageClient({
  data,
  workspaceSlug,
  onDataChanged,
}: {
  data: McpConnectionDetailPageData;
  workspaceSlug: string;
  onDataChanged?: () => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const [tab, setTab] = useState<TabId>("overview");
  const [isPending, startTransition] = useTransition();

  function runAction(work: () => Promise<ActionToastResult<void>>): void {
    startTransition(async () => {
      await runToastAction({
        action: work,
        onSuccess: async () => refreshWorkspaceModule(onDataChanged, router),
        pushToast,
        tx,
        fallbackError: { zh: "请求失败，请稍后重试。", en: "Request failed. Please try again." },
      });
    });
  }

  const approvedToolSet = useMemo(
    () => new Set(data.connection.approvedTools),
    [data.connection.approvedTools],
  );
  const approvedToolDetails = useMemo(
    () => data.connection.declaredTools.filter((tool) => approvedToolSet.has(tool.name)),
    [approvedToolSet, data.connection.declaredTools],
  );
  const activityEntries = useMemo(() => {
    const ops = data.activity.operations.map((op) => ({
      kind: "operation" as const,
      id: op.id,
      time: op.completedAt ?? op.createdAt,
      content: op,
    }));
    const audits = data.activity.audits.map((audit) => ({
      kind: "audit" as const,
      id: audit.id,
      time: audit.createdAt,
      content: audit,
    }));
    return [...ops, ...audits].sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
    );
  }, [data.activity]);

  const disabled = isPending || !data.canManage;

  return (
    <main className="market-page-shell">
      <section className="market-toolbar">
        <div>
          <Link className="market-back-link" href={`/w/${workspaceSlug}/market?tab=mcp`}>
            ← {tx("返回 MCP 市场", "Back to MCP Market")}
          </Link>
          <h1>{data.connection.catalogDisplayName}</h1>
          <p>{data.connection.catalogDescription || data.connection.catalogSlug}</p>
        </div>
        <span className={`status-chip status-chip--${statusTone(data.connection.status)}`}>
          {statusLabel(data.connection.status, tx)}
        </span>
      </section>

      <div className="market-tab-switcher" role="tablist">
        {([
          ["overview", tx("概览", "Overview")],
          ["tools", tx("工具", "Tools")],
          ["config", tx("配置", "Configuration")],
          ["activity", tx("活动", "Activity")],
        ] as Array<[TabId, string]>).map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            className={`market-tab${tab === id ? " market-tab--active" : ""}`}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <section className="market-detail-panel">
          <div className="market-facts-grid">
            <Fact label={tx("Runtime", "Runtime")} value={data.connection.runtimeLabel} />
            <Fact label={tx("传输", "Transport")} value={data.connection.transport} />
            <Fact label={tx("状态", "Status")} value={statusLabel(data.connection.status, tx)} />
            <Fact
              label={tx("已获准工具", "Approved tools")}
              value={`${data.connection.approvedTools.length}/${data.connection.declaredTools.length}`}
            />
            <Fact
              label={tx("下次健康巡检", "Next health check")}
              value={formatTime(data.connection.nextHealthCheckAt, tx)}
            />
            <Fact
              label={tx("连续巡检失败", "Consecutive failures")}
              value={String(data.connection.healthCheckConsecutiveFailures)}
            />
            <Fact
              label={tx("上次验证", "Last verified")}
              value={formatTime(data.connection.lastVerifiedAt, tx)}
            />
            <Fact label={tx("允许网络", "Allowed hosts")} value={data.connection.allowedHosts.join(", ") || "—"} />
          </div>
          {data.connection.lastErrorCode ? (
            <p className="mcp-connection-error">
              {data.connection.lastErrorCode}
              {data.connection.lastErrorMessage ? `: ${data.connection.lastErrorMessage}` : ""}
            </p>
          ) : null}

          <div className="market-action-row">
            <ActionButton
              disabled={disabled}
              icon="refresh"
              label={tx("重新验证", "Re-verify")}
              onClick={() => runAction(() => reverifyMcpConnectionAction({ connectionId: data.connection.id }))}
            />
            {data.connection.status === "disabled" ? (
              <ActionButton
                disabled={disabled}
                icon="checkCircle"
                label={tx("启用", "Enable")}
                onClick={() => runAction(() => enableMcpConnectionAction({ connectionId: data.connection.id }))}
              />
            ) : (
              <ActionButton
                disabled={disabled}
                icon="stop"
                label={tx("停用", "Disable")}
                onClick={() => runAction(() => disableMcpConnectionAction({ connectionId: data.connection.id }))}
              />
            )}
            <ActionButton
              disabled={disabled}
              icon="trash"
              label={tx("移除", "Remove")}
              onClick={() => runAction(() => removeMcpConnectionAction({ connectionId: data.connection.id }))}
              variant="danger"
            />
          </div>
          {!data.canManage ? <p className="panel-note">{tx("只有 workspace 管理员可以管理连接。", "Only workspace admins can manage connections.")}</p> : null}
        </section>
      ) : null}

      {tab === "tools" ? (
        <section className="market-detail-panel">
          <h3 className="mcp-section-label">{tx("已获准工具", "Approved tools")}</h3>
          {approvedToolDetails.length === 0 ? (
            <p className="market-empty">{tx("未选择任何工具。", "No tools are approved.")}</p>
          ) : (
            <ul className="mcp-tool-list">
              {approvedToolDetails.map((tool) => (
                <li className="mcp-tool-row" key={tool.name}>
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                  </span>
                  <span className={`status-chip status-chip--${riskTone(tool.risk)}`}>{tool.risk}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="mcp-section-label">{tx("声明工具", "Declared tools")}</h3>
          <ul className="mcp-tool-list">
            {data.connection.declaredTools.map((tool) => (
              <li className="mcp-tool-row" key={tool.name}>
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.description}</small>
                </span>
                <span className={`status-chip status-chip--${riskTone(tool.risk)}`}>{tool.risk}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "config" ? (
        <section className="market-detail-panel">
          <div className="market-facts-grid">
            <Fact label={tx("Endpoint", "Endpoint")} value={data.connection.endpoint || "—"} />
            <Fact label={tx("数据域", "Data domains")} value={data.connection.dataDomains.join(", ") || "—"} />
          </div>
          <h3 className="mcp-section-label">{tx("非密钥参数", "Non-secret parameters")}</h3>
          <pre className="mcp-config-json">{JSON.stringify(data.connection.nonSecretParams, null, 2)}</pre>
          <p className="panel-note">
            {tx("要修改配置，请在 MCP 市场中点击“管理配置”。", "To change configuration, choose “Manage configuration” from the MCP Market.")}
          </p>
        </section>
      ) : null}

      {tab === "activity" ? (
        <section className="market-detail-panel">
          <ul className="mcp-activity-list">
            {activityEntries.map((entry) => (
              <li className="mcp-activity-row" key={`${entry.kind}-${entry.id}`}>
                {entry.kind === "operation" ? (
                  <McpOperationActivityRow operation={entry.content} tx={tx} />
                ) : (
                  <McpAuditActivityRow audit={entry.content} tx={tx} />
                )}
              </li>
            ))}
          </ul>
          {activityEntries.length === 0 ? (
            <p className="market-empty">{tx("暂无活动记录。", "No activity yet.")}</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function McpOperationActivityRow({
  operation,
  tx,
}: {
  operation: McpConnectionDetailPageData["activity"]["operations"][number];
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className="mcp-activity-entry">
      <span className="mcp-activity-time">
        <time dateTime={operation.completedAt ?? operation.createdAt}>
          {formatTime(operation.completedAt ?? operation.createdAt, tx)}
        </time>
      </span>
      <span className="mcp-activity-badge">{tx("操作", "Operation")}</span>
      <span className="mcp-activity-title">
        {operationLabel(operation.operation, tx)}
        {" "}
        <span className={`status-chip status-chip--${operationStatusTone(operation.status)}`}>
          {operationStatusLabel(operation.status, tx)}
        </span>
      </span>
      {operation.source ? <span className="mcp-activity-meta">{operation.source}</span> : null}
      {operation.errorMessage ? <span className="mcp-connection-error">{operation.errorMessage}</span> : null}
    </div>
  );
}

function McpAuditActivityRow({
  audit,
  tx,
}: {
  audit: McpConnectionDetailPageData["activity"]["audits"][number];
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className="mcp-activity-entry">
      <span className="mcp-activity-time">
        <time dateTime={audit.createdAt}>{formatTime(audit.createdAt, tx)}</time>
      </span>
      <span className="mcp-activity-badge">{tx("工具调用", "Tool call")}</span>
      <span className="mcp-activity-title">
        {audit.toolName}
        {" "}
        <span className={`status-chip status-chip--${audit.outcome === "succeeded" ? "positive" : audit.outcome === "failed" ? "danger" : "neutral"}`}>
          {audit.outcome}
        </span>
      </span>
      {audit.latencyMs ? <span className="mcp-activity-meta">{audit.latencyMs} ms</span> : null}
      {audit.safeSummary ? <span className="mcp-activity-meta">{audit.safeSummary}</span> : null}
    </div>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onClick,
  variant,
}: {
  disabled: boolean;
  icon: AppIconName;
  label: string;
  onClick: () => void;
  variant?: "danger";
}) {
  return (
    <button
      className={`modal-secondary-button${variant === "danger" ? " mcp-danger-button" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <AppIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="market-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function statusTone(status: string): "positive" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "positive";
  if (status === "verifying" || status === "queued_verification") return "warning";
  if (status === "failed" || status === "degraded") return "danger";
  return "neutral";
}

function statusLabel(status: string, tx: (zh: string, en: string) => string): string {
  switch (status) {
    case "ready": return tx("已验证", "Verified");
    case "verifying": return tx("验证中", "Verifying");
    case "queued_verification": return tx("等待验证", "Queued");
    case "failed": return tx("失败", "Failed");
    case "degraded": return tx("需要处理", "Needs attention");
    case "disabled": return tx("已停用", "Disabled");
    default: return tx("未配置", "Needs config");
  }
}

function operationStatusTone(status: string): "positive" | "warning" | "danger" | "neutral" {
  if (status === "succeeded") return "positive";
  if (status === "pending" || status === "claimed" || status === "running") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

function operationStatusLabel(status: string, tx: (zh: string, en: string) => string): string {
  switch (status) {
    case "succeeded": return tx("成功", "Succeeded");
    case "pending": return tx("待处理", "Pending");
    case "claimed": return tx("已认领", "Claimed");
    case "running": return tx("运行中", "Running");
    case "failed": return tx("失败", "Failed");
    case "cancelled": return tx("已取消", "Cancelled");
    default: return status;
  }
}

function operationLabel(operation: string, tx: (zh: string, en: string) => string): string {
  switch (operation) {
    case "verify": return tx("验证", "Verify");
    case "enable": return tx("启用", "Enable");
    case "disable": return tx("停用", "Disable");
    case "remove": return tx("移除", "Remove");
    default: return operation;
  }
}

function riskTone(risk: "low" | "medium" | "high"): "positive" | "warning" | "danger" {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "positive";
}

function formatTime(value: string | undefined, tx: (zh: string, en: string) => string): string {
  if (!value) return tx("—", "—");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tx("时间未知", "Unknown time");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
