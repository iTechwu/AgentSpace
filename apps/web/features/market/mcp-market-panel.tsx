"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  createMcpCatalogItemAction,
  disableMcpConnectionAction,
  enableMcpConnectionAction,
  removeMcpConnectionAction,
  replaceMcpConnectionConfigAction,
  requestMcpConnectionAction,
  reverifyMcpConnectionAction,
} from "@/features/market/mcp-actions";
import type { CreateMcpCatalogItemActionInput } from "@/features/market/mcp-actions";
import { requestRuntimeAppOperationAction } from "@/features/market/actions";
import { CreateMcpCatalogModal } from "@/features/market/create-mcp-catalog-modal";
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
  const [categoryFilter, setCategoryFilter] = useState<"all" | CatalogEntry["category"]>("all");
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
  const [showCreateCatalog, setShowCreateCatalog] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Dirty flags prevent silent overwrites when editing an existing connection.
  // Fields that were never touched by the user are sent as undefined, so the
  // service keeps their stored values. New connections start with everything dirty.
  const [dirtyEndpoint, setDirtyEndpoint] = useState(false);
  const [dirtyNonSecretParams, setDirtyNonSecretParams] = useState<Set<string>>(new Set());

  const onlineRuntimes = useMemo(() => data.runtimes.filter((r) => r.status === "online" && r.mcpEligible), [data.runtimes]);
  const sources = useMemo(() => Array.from(new Set(data.mcpCatalog.map((item) => item.source))).sort(), [data.mcpCatalog]);
  const categories = useMemo(() => Array.from(new Set(data.mcpCatalog.map((item) => item.category))).sort(), [data.mcpCatalog]);
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
        (categoryFilter === "all" || item.category === categoryFilter) &&
        (transportFilter === "all" || item.transport === transportFilter) &&
        (riskFilter === "all" || item.risk === riskFilter) &&
        (connectionFilter === "all" || catalogConnectionState.get(item.id) === connectionFilter);
    });
  }, [catalogConnectionState, categoryFilter, connectionFilter, data.mcpCatalog, data.mcpConnections, query, riskFilter, runtimeFilter, sourceFilter, transportFilter]);

  const selected = data.mcpCatalog.find((item) => item.id === selectedCatalogId) ?? filteredCatalog[0] ?? data.mcpCatalog[0];
  const selectedRuntime = onlineRuntimes.find((r) => r.id === selectedRuntimeId) ?? onlineRuntimes[0];
  const editingConnection = editingConnectionId ? data.mcpConnections.find((connection) => connection.id === editingConnectionId) : undefined;
  const formRuntimes = editingConnection
    ? data.runtimes.filter((runtime) => runtime.id === editingConnection.runtimeId)
    : onlineRuntimes;
  const formRuntimeId = editingConnection?.runtimeId ?? selectedRuntime?.id ?? "";
  const supportsSelectedTransport = selected?.transport === "streamable_http" || selected?.transport === "managed_stdio";
  const requiredRuntimeApp = selected?.requiredRuntimeApp;
  const requiredRuntimeInstallation = requiredRuntimeApp && selectedRuntime
    ? data.installedApps.find((app) =>
        app.runtimeId === selectedRuntime.id &&
        app.source === requiredRuntimeApp.source &&
        app.name === requiredRuntimeApp.name,
      )
    : undefined;
  const requiredRuntimeAppReady = !requiredRuntimeApp || Boolean(
    requiredRuntimeInstallation?.status === "installed" &&
    requiredRuntimeInstallation.enabled &&
    requiredRuntimeInstallation.version === requiredRuntimeApp.version,
  );
  const requiredRuntimeAppOperationActive = Boolean(requiredRuntimeApp && selectedRuntime && data.operations.some((operation) =>
    operation.runtimeId === selectedRuntime.id &&
    operation.appSource === requiredRuntimeApp.source &&
    operation.appName === requiredRuntimeApp.name &&
    isActiveStatus(operation.status),
  ));
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
    if (![...data.mcpOperations, ...data.operations].some((op) => isActiveStatus(op.status))) return;
    const timeoutId = window.setTimeout(() => refreshWorkspaceModule(onDataChanged, router), 2_500);
    return () => window.clearTimeout(timeoutId);
  }, [data.mcpOperations, data.operations, onDataChanged, router]);

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

  function createCatalogItem(input: CreateMcpCatalogItemActionInput): void {
    startTransition(async () => {
      await runToastAction({
        action: () => createMcpCatalogItemAction(input),
        onSuccess: async () => {
          setShowCreateCatalog(false);
          await refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: { zh: "MCP 服务发布失败，请检查目录字段。", en: "Failed to publish the MCP service. Check the catalog fields." },
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

  function installRequiredRuntimeApp(): void {
    if (!requiredRuntimeApp || !selectedRuntime) return;
    runAction(() => requestRuntimeAppOperationAction({
      runtimeId: selectedRuntime.id,
      source: requiredRuntimeApp.source,
      name: requiredRuntimeApp.name,
      operation: "install",
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
  const activeFilterCount = [sourceFilter, categoryFilter, transportFilter, riskFilter, connectionFilter, runtimeFilter]
    .filter((filter) => filter !== "all").length;

  function clearFilters(): void {
    setQuery("");
    setSourceFilter("all");
    setCategoryFilter("all");
    setTransportFilter("all");
    setRiskFilter("all");
    setConnectionFilter("all");
    setRuntimeFilter("all");
  }

  return (
    <div aria-labelledby="mcp-market-heading" className="market-tab-panel" id="mcp-market-panel" role="tabpanel">
      <div className="market-panel-header">
        <div>
          <h2 id="mcp-market-heading">{tx("MCP 服务", "MCP services")}</h2>
          <p>{tx("从工作区目录选择服务，配置工具权限并连接到兼容的 Runtime。", "Choose a workspace catalog service, configure tool access, and connect it to a compatible runtime.")}</p>
        </div>
        <div className="market-panel-header__actions">
          {needsAttention > 0 ? (
            <span className="status-chip status-chip--danger">{tx(`需要处理 ${needsAttention} 项`, `${needsAttention} need attention`)}</span>
          ) : null}
          {data.canManage ? (
            <button className="action-button" disabled={isPending} onClick={() => setShowCreateCatalog(true)} type="button">
              <AppIcon name="plus" />
              <span>{tx("添加 MCP 服务", "Add MCP service")}</span>
            </button>
          ) : null}
        </div>
      </div>

      {data.mcpCatalog.length === 0 ? (
        <section className="market-empty-state">
          <span className="market-empty-icon"><AppIcon name="containers" /></span>
          <h3>{tx("MCP 服务目录为空", "The MCP catalog is empty")}</h3>
          <p>{tx("当前工作区还没有 MCP 服务。发布工作区私有服务后会显示在这里。", "This workspace has no MCP services yet. Workspace-private releases will appear here.")}</p>
          {data.canManage ? (
            <button className="action-button market-empty-state__action" disabled={isPending} onClick={() => setShowCreateCatalog(true)} type="button">
              <AppIcon name="plus" />
              <span>{tx("添加第一个服务", "Add the first service")}</span>
            </button>
          ) : null}
        </section>
      ) : (
        <div className="market-workbench">
          <aside className="market-catalog-panel" aria-label={tx("MCP 筛选与目录", "MCP filters and catalog")}>
            <div className="market-catalog-tools">
              <label className="market-search">
                <AppIcon name="search" />
                <input
                  aria-label={tx("搜索 MCP 服务", "Search MCP services")}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={tx("搜索服务、工具或数据域", "Search services, tools, or data domains")}
                  value={query}
                />
              </label>
              <div className="mcp-filter-heading">
                <strong>{tx("筛选", "Filters")}</strong>
                <button disabled={activeFilterCount === 0 && !query} onClick={clearFilters} type="button">
                  {tx("清除", "Clear")}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                </button>
              </div>
              <div className="mcp-filter-grid">
                <label className="form-field">
                  <span>{tx("类别", "Category")}</span>
                  <select onChange={(event) => setCategoryFilter(event.currentTarget.value as "all" | CatalogEntry["category"])} value={categoryFilter}>
                    <option value="all">{tx("全部类别", "All categories")}</option>
                    {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                  </select>
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
              </div>
            </div>

            <div className="market-catalog-meta">
              <strong>{tx("服务目录", "Service catalog")}</strong>
              <span>{tx(`${filteredCatalog.length} 个结果`, `${filteredCatalog.length} results`)}</span>
            </div>
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
                    <span className="market-app-identity">
                      <strong>{item.displayName}</strong>
                      <small>{item.description || item.slug}</small>
                    </span>
                    <span className="market-app-meta">
                      <strong>{transportLabel(item.transport, tx)}</strong>
                      <small>
                        {connectionState === "needs_attention" ? tx("需要处理", "Needs attention") : connectionState === "connected" ? tx("已连接", "Connected") : tx("未连接", "Not connected")}
                        {connectedCount > 0 ? tx(` · ${connectedCount} 个 Runtime`, ` · ${connectedCount} runtime(s)`) : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
              {filteredCatalog.length === 0 ? (
                <div className="market-filter-empty">
                  <AppIcon name="search" />
                  <strong>{tx("没有匹配的 MCP 服务", "No matching MCP services")}</strong>
                  <button onClick={clearFilters} type="button">{tx("清除筛选", "Clear filters")}</button>
                </div>
              ) : null}
            </section>
          </aside>

          <aside className="market-detail-panel" aria-label={tx("MCP 详情", "MCP details")}>
            {selected ? (
              <>
                <div className="market-detail-heading">
                  <div>
                    <span className="market-detail-kicker">MCP · {selected.category}</span>
                    <h2>{selected.displayName}</h2>
                    <p>{selected.description || selected.slug}</p>
                  </div>
                  <span className={`status-chip status-chip--${riskTone(selected.risk)}`}>{selected.risk}</span>
                </div>

              <div className="market-facts-grid">
                <Fact label={tx("版本", "Release")} value={selected.version} />
                <Fact label={tx("类别", "Category")} value={selected.category} />
                <Fact label={tx("传输", "Transport")} value={selected.transport} />
                <Fact label={tx("声明工具数", "Declared tools")} value={String(selected.declaredTools.length)} />
                <Fact label={tx("数据域", "Data domains")} value={selected.dataDomains.join(", ") || "—"} />
                <Fact label={tx("允许网络", "Allowed hosts")} value={selected.allowedHosts.join(", ") || "—"} />
                {requiredRuntimeApp ? (
                  <Fact
                    label={tx("Runtime 组件", "Runtime component")}
                    value={requiredRuntimeAppReady ? tx("已安装", "Installed") : `${requiredRuntimeApp.name}@${requiredRuntimeApp.version}`}
                  />
                ) : null}
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
                  <span>{selected.transport === "managed_stdio" ? tx("受管 stdio 入口", "Managed stdio entrypoint") : tx("Endpoint (HTTPS)", "Endpoint (HTTPS)")}</span>
                  <input
                    onChange={(event) => {
                      setDirtyEndpoint(true);
                      setEndpoint(event.currentTarget.value);
                    }}
                    placeholder={selected.transport === "managed_stdio" ? "stdio://my-mcp-server" : "https://mcp.example.com/mcp"}
                    readOnly={selected.transport === "managed_stdio"}
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
                {requiredRuntimeApp && !requiredRuntimeAppReady ? (
                  <button
                    className="primary-button"
                    disabled={isPending || !data.canManage || !selectedRuntime || requiredRuntimeAppOperationActive}
                    onClick={installRequiredRuntimeApp}
                    type="button"
                  >
                    <AppIcon name="download" />
                    <span>{requiredRuntimeAppOperationActive ? tx("正在安装", "Installing") : tx("安装 Runtime 组件", "Install runtime component")}</span>
                  </button>
                ) : null}
                <button
                  className="primary-button"
                  disabled={isPending || !data.canManage || !supportsSelectedTransport || !selectedRuntime || !requiredRuntimeAppReady || !isSubmittable()}
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
                <p className="panel-note">{tx("当前传输尚未开放连接。", "This transport is not connectable yet.")}</p>
              ) : null}
              </>
            ) : null}
          </aside>
        </div>
      )}

      <section className="mcp-connections-section" aria-label={tx("已连接 MCP 服务", "Connected MCP services")}>
        <div className="mcp-connections-heading">
          <div>
            <h3>{tx("已连接服务", "Connected services")}</h3>
            <p>{tx("集中管理 Runtime 上已启用的 MCP 连接。", "Manage active MCP connections across runtimes.")}</p>
          </div>
          <span>{data.mcpConnections.length}</span>
        </div>
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
      {showCreateCatalog ? (
        <CreateMcpCatalogModal
          onCancel={() => setShowCreateCatalog(false)}
          onConfirm={createCatalogItem}
          pending={isPending}
        />
      ) : null}
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
  if (transport === "streamable_http" || transport === "managed_stdio") return transport;
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
