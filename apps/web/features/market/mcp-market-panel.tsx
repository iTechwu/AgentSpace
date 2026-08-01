"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disableMcpConnectionAction,
  enableMcpConnectionAction,
  removeMcpConnectionAction,
  requestMcpConnectionAction,
  reverifyMcpConnectionAction,
} from "@/features/market/mcp-actions";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction, type ActionToastResult } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import type { MarketPageData } from "@/features/market/market-page-client";

type CatalogEntry = MarketPageData["mcpCatalog"][number];
type ConnectionEntry = MarketPageData["mcpConnections"][number];

export function McpMarketPanel({ data, onDataChanged }: { data: MarketPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const [query, setQuery] = useState("");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>(data.mcpCatalog[0]?.id ?? "");
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(data.runtimes[0]?.id ?? "");
  const [endpoint, setEndpoint] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [approvedTools, setApprovedTools] = useState<Set<string>>(new Set());
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [isPending, startTransition] = useTransition();

  const onlineRuntimes = useMemo(() => data.runtimes.filter((r) => r.status === "online"), [data.runtimes]);
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("en-US");
    if (!q) return data.mcpCatalog;
    return data.mcpCatalog.filter((item) =>
      `${item.displayName} ${item.slug} ${item.description} ${item.dataDomains.join(" ")}`.toLocaleLowerCase("en-US").includes(q),
    );
  }, [data.mcpCatalog, query]);

  const selected = data.mcpCatalog.find((item) => item.id === selectedCatalogId) ?? filteredCatalog[0] ?? data.mcpCatalog[0];
  const selectedRuntime = onlineRuntimes.find((r) => r.id === selectedRuntimeId) ?? onlineRuntimes[0];
  const supportsSelectedTransport = selected?.transport === "streamable_http";

  // Reset per-catalog form state when the selection changes.
  useEffect(() => {
    if (!selected) return;
    setEndpoint(selected.endpointTemplate ?? "");
    setApprovedTools(new Set(selected.defaultApprovedTools));
    setSecrets(Object.fromEntries(selected.secretFields.map((field) => [field, ""])));
    setConfirmHighRisk(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data.mcpOperations.some((op) => isActiveStatus(op.status))) return;
    const timeoutId = window.setTimeout(() => refreshWorkspaceModule(onDataChanged, router), 2_500);
    return () => window.clearTimeout(timeoutId);
  }, [data.mcpOperations, onDataChanged, router]);

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

  function toggleTool(name: string): void {
    setApprovedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const needsAttention = data.mcpConnections.filter((c) => c.status === "failed" || c.status === "degraded").length;

  return (
    <div className="market-tab-panel">
      <div className="market-panel-actions">
        <span className="mcp-subtitle">{tx("MCP 中心", "MCP Center")}</span>
        <span className="mcp-subtitle-note">{tx("连接审核过的 MCP 服务到 Docker Runtime。", "Connect reviewed MCP services to a Docker Runtime.")}</span>
        {needsAttention > 0 ? (
          <span className="status-chip status-chip--danger">{tx(`需要处理 ${needsAttention} 项`, `${needsAttention} need attention`)}</span>
        ) : null}
      </div>

      <div className="market-workbench">
        <aside className="market-filter-panel" aria-label={tx("MCP 筛选", "MCP filters")}>
          <label className="market-search">
            <AppIcon name="search" />
            <input
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={tx("搜索服务、工具或数据域", "Search service, tool or data domain")}
              value={query}
            />
          </label>
          <section className="market-app-list" aria-label={tx("MCP 服务目录", "MCP service catalog")}>
            {filteredCatalog.map((item) => {
              const active = selected?.id === item.id;
              const connected = data.mcpConnections.some((c) => c.catalogItemId === item.id);
              return (
                <button
                  className={`market-app-row${active ? " market-app-row--active" : ""}`}
                  key={item.id}
                  onClick={() => setSelectedCatalogId(item.id)}
                  type="button"
                >
                  <span className={`market-risk-dot market-risk-dot--${item.risk}`} />
                  <strong>{item.displayName}</strong>
                  <span>{item.transport}</span>
                  <small>{connected ? tx("已连接", "Connected") : tx("未连接", "Not connected")}</small>
                </button>
              );
            })}
            {filteredCatalog.length === 0 ? (
              <p className="market-empty">{tx("暂无 MCP 服务。", "No MCP services yet.")}</p>
            ) : null}
          </section>
        </aside>

        <aside className="market-detail-panel" aria-label={tx("MCP 详情", "MCP details")}>
          {selected ? (
            <>
              <div className="market-detail-heading">
                <div>
                  <h2>{selected.displayName}</h2>
                  <p>{selected.description || selected.slug}</p>
                </div>
                <span className={`status-chip status-chip--${riskTone(selected.risk)}`}>{selected.risk}</span>
              </div>

              <div className="market-facts-grid">
                <Fact label={tx("传输", "Transport")} value={selected.transport} />
                <Fact label={tx("声明工具数", "Declared tools")} value={String(selected.declaredTools.length)} />
                <Fact label={tx("数据域", "Data domains")} value={selected.dataDomains.join(", ") || "—"} />
                <Fact label={tx("允许网络", "Allowed hosts")} value={selected.allowedHosts.join(", ") || "—"} />
              </div>

              <div className="mcp-tool-scope">
                <span className="mcp-section-label">{tx("工具范围", "Tool scope")}</span>
                {selected.declaredTools.map((tool) => (
                  <label key={tool.name} className="mcp-tool-row">
                    <input
                      checked={approvedTools.has(tool.name)}
                      onChange={() => toggleTool(tool.name)}
                      type="checkbox"
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                    </span>
                    <span className={`status-chip status-chip--${riskTone(tool.risk)}`}>{tool.risk}</span>
                  </label>
                ))}
              </div>

              <div className="market-runtime-box">
                <label className="form-field">
                  <span>{tx("目标 Runtime", "Target runtime")}</span>
                  <select
                    disabled={isPending || onlineRuntimes.length === 0}
                    onChange={(event) => setSelectedRuntimeId(event.currentTarget.value)}
                    value={selectedRuntime?.id ?? ""}
                  >
                    {onlineRuntimes.map((runtime) => (
                      <option key={runtime.id} value={runtime.id}>{runtime.label}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>{tx("Endpoint (HTTPS)", "Endpoint (HTTPS)")}</span>
                  <input
                    onChange={(event) => setEndpoint(event.currentTarget.value)}
                    placeholder="https://mcp.example.com/mcp"
                    value={endpoint}
                  />
                </label>
                {selected.secretFields.map((field) => (
                  <label key={field} className="form-field">
                    <span>{field}</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setSecrets((prev) => ({ ...prev, [field]: event.currentTarget.value }))}
                      placeholder={tx("保存后不会显示", "Will not be shown after save")}
                      type="password"
                      value={secrets[field] ?? ""}
                    />
                  </label>
                ))}
              </div>

              {selected.risk === "high" || selected.declaredTools.some((t) => t.risk === "high" && approvedTools.has(t.name)) ? (
                <label className="market-confirm-risk">
                  <input checked={confirmHighRisk} onChange={(event) => setConfirmHighRisk(event.currentTarget.checked)} type="checkbox" />
                  <span>{tx("确认该 Runtime 将访问指定数据域", "I confirm this runtime will access the stated data domain")}</span>
                </label>
              ) : null}

              <div className="market-action-row">
                <button
                  className="primary-button"
                  disabled={isPending || !data.canManage || !supportsSelectedTransport || !selectedRuntime || !endpoint.trim() || !allSecretsFilled(selected, secrets)}
                  onClick={() => runAction(() => requestMcpConnectionAction({
                    runtimeId: selectedRuntime!.id,
                    catalogItemId: selected.id,
                    endpoint,
                    secrets,
                    approvedTools: Array.from(approvedTools),
                    confirmHighRisk,
                  }))}
                  type="button"
                >
                  <AppIcon name="download" />
                  <span>{tx("配置并连接", "Configure and connect")}</span>
                </button>
              </div>
              {!supportsSelectedTransport ? (
                <p className="panel-note">{tx("当前版本仅支持 Streamable HTTP MCP。", "This version supports Streamable HTTP MCP only.")}</p>
              ) : null}
            </>
          ) : (
            <p className="market-empty">{tx("暂无 MCP 服务。", "No MCP services yet.")}</p>
          )}
        </aside>
      </div>

      <section className="mcp-connections-section" aria-label={tx("已连接 MCP 服务", "Connected MCP services")}>
        <h3>{tx("已连接服务", "Connected services")} ({data.mcpConnections.length})</h3>
        {data.mcpConnections.length === 0 ? (
          <p className="market-empty">{tx("尚未连接 MCP 服务。", "No MCP connections yet.")}</p>
        ) : (
          <ul className="mcp-connection-list">
            {data.mcpConnections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                canManage={data.canManage}
                disabled={isPending}
                onReverify={() => runAction(() => reverifyMcpConnectionAction({ connectionId: connection.id }))}
                onDisable={() => runAction(() => disableMcpConnectionAction({ connectionId: connection.id }))}
                onEnable={() => runAction(() => enableMcpConnectionAction({ connectionId: connection.id }))}
                onRemove={() => runAction(() => removeMcpConnectionAction({ connectionId: connection.id }))}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConnectionRow(props: {
  connection: ConnectionEntry;
  canManage: boolean;
  disabled: boolean;
  onReverify: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
}) {
  const { tx } = useLanguage();
  const { connection, canManage, disabled } = props;
  return (
    <li className="mcp-connection-row">
      <div className="mcp-connection-head">
        <strong>{connection.catalogDisplayName}</strong>
        <span className={`status-chip status-chip--${statusTone(connection.status)}`}>{statusLabel(connection.status, tx)}</span>
      </div>
      <div className="mcp-connection-meta">
        <span>{connection.transport}</span>
        <span>{tx("已获准工具", "Approved tools")}: {connection.approvedTools.length}/{connection.declaredToolCount}</span>
        {connection.lastErrorCode ? <span className="mcp-connection-error">{connection.lastErrorCode}{connection.lastErrorMessage ? `: ${connection.lastErrorMessage}` : ""}</span> : null}
      </div>
      <div className="market-action-row">
        <button className="modal-secondary-button" disabled={disabled || !canManage || connection.status === "disabled"} onClick={props.onReverify} type="button">
          {tx("重新验证", "Re-verify")}
        </button>
        {connection.status === "disabled" ? (
          <button className="modal-secondary-button" disabled={disabled || !canManage} onClick={props.onEnable} type="button">
            {tx("启用", "Enable")}
          </button>
        ) : (
          <button className="modal-secondary-button" disabled={disabled || !canManage || connection.status === "disabled"} onClick={props.onDisable} type="button">
            {tx("停用", "Disable")}
          </button>
        )}
        <button className="modal-secondary-button mcp-danger-button" disabled={disabled || !canManage} onClick={props.onRemove} type="button">
          {tx("移除", "Remove")}
        </button>
      </div>
    </li>
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

function isActiveStatus(status: string): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

function riskTone(risk: "low" | "medium" | "high"): "positive" | "warning" | "danger" {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "positive";
}

function statusTone(status: string): "positive" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "positive";
  if (status === "verifying" || status === "queued_verification") return "warning";
  if (status === "failed" || status === "degraded") return "danger";
  return "neutral";
}

function statusLabel(status: string, tx: (zh: string, en: string) => string): string {
  switch (status) {
    // `ready` currently means the remote endpoint and credentials were verified.
    // Do not claim task availability until the isolated runtime gateway is enabled.
    case "ready": return tx("已验证", "Verified");
    case "verifying": return tx("验证中", "Verifying");
    case "queued_verification": return tx("等待验证", "Queued");
    case "failed": return tx("失败", "Failed");
    case "degraded": return tx("需要处理", "Needs attention");
    case "disabled": return tx("已停用", "Disabled");
    default: return tx("未配置", "Needs config");
  }
}

function allSecretsFilled(catalog: CatalogEntry, secrets: Record<string, string>): boolean {
  return catalog.secretFields.every((field) => (secrets[field] ?? "").trim().length > 0);
}
