"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  disableMcpConnectionAction,
  enableMcpConnectionAction,
  removeMcpConnectionAction,
  replaceMcpConnectionConfigAction,
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
  const [sourceFilter, setSourceFilter] = useState<"all" | CatalogEntry["source"]>("all");
  const [transportFilter, setTransportFilter] = useState<"all" | CatalogEntry["transport"]>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | CatalogEntry["risk"]>("all");
  const [connectionFilter, setConnectionFilter] = useState<"all" | "connected" | "not_connected" | "needs_attention">("all");
  const [runtimeFilter, setRuntimeFilter] = useState<string>("all");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>(data.mcpCatalog[0]?.id ?? "");
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(data.runtimes[0]?.id ?? "");
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [nonSecretParams, setNonSecretParams] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [approvedTools, setApprovedTools] = useState<Set<string>>(new Set());
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Dirty flags prevent silent overwrites when editing an existing connection.
  // Fields that were never touched by the user are sent as undefined, so the
  // service keeps their stored values. New connections start with everything dirty.
  const [dirtyEndpoint, setDirtyEndpoint] = useState(false);
  const [dirtyNonSecretParams, setDirtyNonSecretParams] = useState<Set<string>>(new Set());

  const onlineRuntimes = useMemo(() => data.runtimes.filter((r) => r.status === "online" && r.mcpEligible), [data.runtimes]);
  const sources = useMemo(() => Array.from(new Set(data.mcpCatalog.map((item) => item.source))).sort(), [data.mcpCatalog]);
  const catalogConnectionState = useMemo(() => new Map(data.mcpCatalog.map((item) => {
    const connections = data.mcpConnections.filter((connection) => connection.catalogItemId === item.id);
    const state = connections.length === 0
      ? "not_connected"
      : connections.some((connection) => connection.status === "failed" || connection.status === "degraded")
        ? "needs_attention"
        : "connected";
    return [item.id, state] as const;
  })), [data.mcpCatalog, data.mcpConnections]);
  const catalogConnectedRuntimeCount = useMemo(() => new Map(data.mcpCatalog.map((item) => {
    const runtimeIds = new Set(data.mcpConnections.filter((connection) => connection.catalogItemId === item.id).map((connection) => connection.runtimeId));
    return [item.id, runtimeIds.size] as const;
  })), [data.mcpCatalog, data.mcpConnections]);
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("en-US");
    return data.mcpCatalog.filter((item) => {
      const connectedOnRuntime = runtimeFilter === "all" || data.mcpConnections.some((connection) =>
        connection.catalogItemId === item.id && connection.runtimeId === runtimeFilter,
      );
      return connectedOnRuntime &&
        (!q || `${item.displayName} ${item.slug} ${item.description} ${item.dataDomains.join(" ")}`.toLocaleLowerCase("en-US").includes(q)) &&
        (sourceFilter === "all" || item.source === sourceFilter) &&
        (transportFilter === "all" || item.transport === transportFilter) &&
        (riskFilter === "all" || item.risk === riskFilter) &&
        (connectionFilter === "all" || catalogConnectionState.get(item.id) === connectionFilter);
    });
  }, [catalogConnectionState, connectionFilter, data.mcpCatalog, data.mcpConnections, query, riskFilter, runtimeFilter, sourceFilter, transportFilter]);

  const selected = data.mcpCatalog.find((item) => item.id === selectedCatalogId) ?? filteredCatalog[0] ?? data.mcpCatalog[0];
  const selectedRuntime = onlineRuntimes.find((r) => r.id === selectedRuntimeId) ?? onlineRuntimes[0];
  const editingConnection = editingConnectionId ? data.mcpConnections.find((connection) => connection.id === editingConnectionId) : undefined;
  const formRuntimes = editingConnection
    ? data.runtimes.filter((runtime) => runtime.id === editingConnection.runtimeId)
    : onlineRuntimes;
  const formRuntimeId = editingConnection?.runtimeId ?? selectedRuntime?.id ?? "";
  const supportsSelectedTransport = selected?.transport === "streamable_http";
  const requiresHighRiskConfirmation = Boolean(selected && (
    !editingConnection
      ? selected.risk === "high" || selected.declaredTools.some((tool) => tool.risk === "high" && approvedTools.has(tool.name))
      : selected.declaredTools.some((tool) => tool.risk === "high" && approvedTools.has(tool.name) && !editingConnection.approvedTools.includes(tool.name))
  ));

  // Reset per-catalog form state when the selection changes.
  // Skip while editing: manageConnection() already initialized the form and
  // dirty flags; running this effect would overwrite them and re-introduce the
  // silent-overwrite risk.
  useEffect(() => {
    if (!selected || editingConnectionId) return;
    setEndpoint(selected.endpointTemplate ?? "");
    setApprovedTools(new Set(selected.defaultApprovedTools));
    setNonSecretParams(Object.fromEntries(selected.configurationFields.map((field) => [field.name, ""])));
    setSecrets(Object.fromEntries(selected.secretFields.map((field) => [field, ""])));
    setConfirmHighRisk(false);
    // New connections: every field is dirty because the user must fill them.
    setDirtyEndpoint(true);
    setDirtyNonSecretParams(new Set(selected.configurationFields.map((field) => field.name)));
  }, [selected, editingConnectionId]);

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

  function manageConnection(connection: ConnectionEntry): void {
    const catalog = data.mcpCatalog.find((item) => item.id === connection.catalogItemId);
    setEditingConnectionId(connection.id);
    setSelectedCatalogId(connection.catalogItemId);
    setSelectedRuntimeId(connection.runtimeId);
    setEndpoint(catalog?.endpointTemplate ?? "");
    setApprovedTools(new Set(connection.approvedTools));
    setNonSecretParams(Object.fromEntries((catalog?.configurationFields ?? []).map((field) => [field.name, ""])));
    setSecrets(Object.fromEntries((catalog?.secretFields ?? []).map((field) => [field, ""])));
    setConfirmHighRisk(false);
    // Editing: existing values are not echoed, so assume untouched until the user changes them.
    setDirtyEndpoint(false);
    setDirtyNonSecretParams(new Set());
  }

  function cancelManagingConnection(): void {
    setEditingConnectionId(null);
    if (!selected) return;
    setEndpoint(selected.endpointTemplate ?? "");
    setApprovedTools(new Set(selected.defaultApprovedTools));
    setNonSecretParams(Object.fromEntries(selected.configurationFields.map((field) => [field.name, ""])));
    setSecrets(Object.fromEntries(selected.secretFields.map((field) => [field, ""])));
    setConfirmHighRisk(false);
    setDirtyEndpoint(true);
    setDirtyNonSecretParams(new Set(selected.configurationFields.map((field) => field.name)));
  }

  function submitConnection(): void {
    if (!selected || (!editingConnection && !selectedRuntime)) return;
    if (!editingConnection) {
      runAction(() => requestMcpConnectionAction({
        runtimeId: selectedRuntime.id,
        catalogItemId: selected.id,
        endpoint,
        nonSecretParams,
        secrets,
        approvedTools: Array.from(approvedTools),
        confirmHighRisk,
      }));
      return;
    }
    // Atomic replacement: only send fields the user actually touched. Untouched
    // endpoint / non-secret config / blank secrets keep their stored values.
    const dirtyNonSecretEntries = Object.entries(nonSecretParams).filter(([name]) => dirtyNonSecretParams.has(name));
    const dirtySecretEntries = Object.entries(secrets).filter(([_, value]) => value.trim().length > 0);
    runAction(() => replaceMcpConnectionConfigAction({
      connectionId: editingConnection.id,
      endpoint: dirtyEndpoint ? endpoint : undefined,
      nonSecretParams: dirtyNonSecretEntries.length > 0 ? Object.fromEntries(dirtyNonSecretEntries) : undefined,
      approvedTools: Array.from(approvedTools),
      secrets: dirtySecretEntries.length > 0 ? Object.fromEntries(dirtySecretEntries) : undefined,
      confirmHighRisk,
    }));
  }

  function isSubmittable(): boolean {
    if (!selected) return false;
    if (requiresHighRiskConfirmation && !confirmHighRisk) return false;
    if (!editingConnection) {
      return endpoint.trim().length > 0 && allConfigurationFieldsFilled(selected, nonSecretParams) && allSecretsFilled(selected, secrets);
    }
    // Editing: only enforce validity on fields the user actually touched.
    if (dirtyEndpoint && !endpoint.trim()) return false;
    for (const field of selected.configurationFields) {
      if (field.required && dirtyNonSecretParams.has(field.name) && !(nonSecretParams[field.name] ?? "").trim()) {
        return false;
      }
    }
    return true;
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
          <label className="form-field">
            <span>{tx("来源", "Source")}</span>
            <select onChange={(event) => setSourceFilter(event.currentTarget.value as "all" | CatalogEntry["source"])} value={sourceFilter}>
              <option value="all">{tx("全部来源", "All sources")}</option>
              {sources.map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>{tx("传输", "Transport")}</span>
            <select onChange={(event) => setTransportFilter(event.currentTarget.value as "all" | CatalogEntry["transport"])} value={transportFilter}>
              <option value="all">{tx("全部传输", "All transports")}</option>
              {/* Only streamable_http is implemented; the other transports are
                  type/UI placeholders and must not be selectable yet. */}
              <option value="streamable_http">streamable_http</option>
            </select>
          </label>
          <label className="form-field">
            <span>{tx("风险", "Risk")}</span>
            <select onChange={(event) => setRiskFilter(event.currentTarget.value as "all" | CatalogEntry["risk"])} value={riskFilter}>
              <option value="all">{tx("全部风险", "All risks")}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label className="form-field">
            <span>{tx("连接状态", "Connection status")}</span>
            <select onChange={(event) => setConnectionFilter(event.currentTarget.value as typeof connectionFilter)} value={connectionFilter}>
              <option value="all">{tx("全部状态", "All statuses")}</option>
              <option value="connected">{tx("已连接", "Connected")}</option>
              <option value="not_connected">{tx("未连接", "Not connected")}</option>
              <option value="needs_attention">{tx("需要处理", "Needs attention")}</option>
            </select>
          </label>
          <label className="form-field">
            <span>{tx("Runtime", "Runtime")}</span>
            <select onChange={(event) => setRuntimeFilter(event.currentTarget.value)} value={runtimeFilter}>
              <option value="all">{tx("全部 Runtime", "All runtimes")}</option>
              {onlineRuntimes.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>{runtime.label}</option>
              ))}
            </select>
          </label>
          <section className="market-app-list" aria-label={tx("MCP 服务目录", "MCP service catalog")}>
            {filteredCatalog.map((item) => {
              const active = selected?.id === item.id;
              const connectionState = catalogConnectionState.get(item.id) ?? "not_connected";
              const connectedCount = catalogConnectedRuntimeCount.get(item.id) ?? 0;
              return (
                <button
                  className={`market-app-row${active ? " market-app-row--active" : ""}`}
                  key={item.id}
                  onClick={() => setSelectedCatalogId(item.id)}
                  type="button"
                >
                  <span className={`market-risk-dot market-risk-dot--${item.risk}`} />
                  <strong>{item.displayName}</strong>
                  <span>{transportLabel(item.transport, tx)}</span>
                  <small>
                    {tx(`已连接 ${connectedCount} 个 Runtime · `, `${connectedCount} runtime(s) · `)}
                    {connectionState === "needs_attention" ? tx("需要处理", "Needs attention") : connectionState === "connected" ? tx("已连接", "Connected") : tx("未连接", "Not connected")}
                  </small>
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
                    disabled={isPending || Boolean(editingConnection) || formRuntimes.length === 0}
                    onChange={(event) => setSelectedRuntimeId(event.currentTarget.value)}
                    value={formRuntimeId}
                  >
                    {formRuntimes.map((runtime) => (
                      <option key={runtime.id} value={runtime.id}>
                        {runtime.label}
                        {" · "}
                        {runtime.mcpEligible ? tx("支持 MCP", "MCP compatible") : tx("不支持 MCP", "MCP not supported")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>{tx("Endpoint (HTTPS)", "Endpoint (HTTPS)")}</span>
                  <input
                    onChange={(event) => {
                      setDirtyEndpoint(true);
                      setEndpoint(event.currentTarget.value);
                    }}
                    placeholder="https://mcp.example.com/mcp"
                    value={endpoint}
                  />
                </label>
                {selected.configurationFields.map((field) => (
                  <label key={field.name} className="form-field">
                    <span>{field.name}{field.required ? " *" : ""}</span>
                    <input
                      autoComplete="off"
                      maxLength={field.maxLength}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setDirtyNonSecretParams((prev) => new Set(prev).add(field.name));
                        setNonSecretParams((prev) => ({ ...prev, [field.name]: value }));
                      }}
                      required={field.required}
                      value={nonSecretParams[field.name] ?? ""}
                    />
                  </label>
                ))}
                {selected.secretFields.map((field) => (
                  <label key={field} className="form-field">
                    <span>{field}</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSecrets((prev) => ({ ...prev, [field]: value }));
                      }}
                      placeholder={tx("保存后不会显示", "Will not be shown after save")}
                      type="password"
                      value={secrets[field] ?? ""}
                    />
                  </label>
                ))}
              </div>

              {editingConnection ? (
                <p className="panel-note">{tx("现有 endpoint、非密钥配置和密钥不会回显。填写的密钥将轮换，留空则保持不变。", "Existing endpoint, configuration, and secrets are not shown. Filled secrets rotate; blank ones stay unchanged.")}</p>
              ) : null}

              {requiresHighRiskConfirmation ? (
                <label className="market-confirm-risk">
                  <input checked={confirmHighRisk} onChange={(event) => setConfirmHighRisk(event.currentTarget.checked)} type="checkbox" />
                  <span>{tx("确认该 Runtime 将访问指定数据域", "I confirm this runtime will access the stated data domain")}</span>
                </label>
              ) : null}

              <div className="market-action-row">
                <button
                  className="primary-button"
                  disabled={isPending || !data.canManage || !supportsSelectedTransport || !selectedRuntime || !isSubmittable()}
                  onClick={submitConnection}
                  type="button"
                >
                  <AppIcon name="download" />
                  <span>{editingConnection ? tx("更新配置", "Update configuration") : tx("配置并连接", "Configure and connect")}</span>
                </button>
                {editingConnection ? (
                  <button className="modal-secondary-button" disabled={isPending} onClick={cancelManagingConnection} type="button">
                    {tx("取消管理", "Cancel")}
                  </button>
                ) : null}
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
                onManage={() => manageConnection(connection)}
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
  onManage: () => void;
}) {
  const { tx } = useLanguage();
  const { connection, canManage, disabled } = props;
  const params = useParams<{ workspaceSlug?: string }>();
  const workspaceSlug = params.workspaceSlug;
  const detailHref = workspaceSlug ? `/w/${workspaceSlug}/market/mcp-connections/${connection.id}` : undefined;
  return (
    <li className="mcp-connection-row">
      <div className="mcp-connection-head">
        <strong>{connection.catalogDisplayName}</strong>
        <span className={`status-chip status-chip--${statusTone(connection.status)}`}>{statusLabel(connection.status, tx)}</span>
      </div>
      <div className="mcp-connection-meta">
        <span>{connection.transport}</span>
        <span>{tx("已获准工具", "Approved tools")}: {connection.approvedTools.length}/{connection.declaredToolCount}</span>
        <span>{tx("上次验证", "Last verified")}: <time dateTime={connection.lastVerifiedAt}>{formatVerificationTime(connection.lastVerifiedAt, tx)}</time></span>
        {connection.lastErrorCode ? <span className="mcp-connection-error">{connection.lastErrorCode}{connection.lastErrorMessage ? `: ${connection.lastErrorMessage}` : ""}</span> : null}
      </div>
      {connection.approvedTools.length > 0 ? (
        <details className="mcp-connection-tools">
          <summary>{tx(`查看工具 (${connection.approvedTools.length})`, `View tools (${connection.approvedTools.length})`)}</summary>
          <ul>{connection.approvedTools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
        </details>
      ) : null}
      <div className="market-action-row">
        {detailHref ? (
          <Link className="modal-secondary-button" href={detailHref}>
            {tx("详情", "Details")}
          </Link>
        ) : null}
        <button className="modal-secondary-button" disabled={disabled || !canManage} onClick={props.onManage} type="button">
          {tx("管理配置", "Manage configuration")}
        </button>
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

function transportLabel(transport: string, tx: (zh: string, en: string) => string): string {
  if (transport === "streamable_http") return transport;
  // Transports beyond streamable_http are type/UI placeholders: they are
  // visible in the catalog but not connectable yet, so they must say so.
  return `${transport} · ${tx("待支持", "not yet")}`;
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

function formatVerificationTime(value: string | undefined, tx: (zh: string, en: string) => string): string {
  if (!value) return tx("从未验证", "Never verified");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tx("时间未知", "Unknown time");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function allSecretsFilled(catalog: CatalogEntry, secrets: Record<string, string>): boolean {
  return catalog.secretFields.every((field) => (secrets[field] ?? "").trim().length > 0);
}

function allConfigurationFieldsFilled(catalog: CatalogEntry, params: Record<string, string>): boolean {
  return catalog.configurationFields.every((field) => !field.required || (params[field.name] ?? "").trim().length > 0);
}
