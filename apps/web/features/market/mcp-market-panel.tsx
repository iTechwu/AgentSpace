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
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import type { MarketPageData } from "@/features/market/market-page-client";
import {
  isActiveCapabilityOperationStatus,
  projectRuntimeAppInstallability,
  runtimeAppInstallabilityReason,
} from "@/features/market/capability-presentation";
import { ManagedMcpSetupProgress } from "@/features/market/managed-mcp-setup-progress";

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
  const [removingConnectionId, setRemovingConnectionId] = useState<string | null>(null);
  const [removalStrategy, setRemovalStrategy] = useState<"prohibit_new_jobs" | "cancel_running_jobs">("prohibit_new_jobs");
  const [isPending, startTransition] = useTransition();
  // Dirty flags prevent silent overwrites when editing an existing connection.
  // Fields that were never touched by the user are sent as undefined, so the
  // service keeps their stored values. New connections start with everything dirty.
  const [dirtyEndpoint, setDirtyEndpoint] = useState(false);
  const [dirtyNonSecretParams, setDirtyNonSecretParams] = useState<Set<string>>(new Set());

  const onlineRuntimes = useMemo(() => data.runtimes.filter((r) => r.status === "online" && r.mcpEligible), [data.runtimes]);
  const sources = useMemo(() => Array.from(new Set(data.mcpCatalog.map((item) => item.source))).sort(), [data.mcpCatalog]);
  const categories = useMemo(() => Array.from(new Set(data.mcpCatalog.map((item) => item.category))).sort(), [data.mcpCatalog]);
  const transports = useMemo(() => Array.from(new Set(data.mcpCatalog
    .map((item) => item.transport)
    .filter((transport) => transport === "streamable_http" || transport === "managed_stdio"))).sort(), [data.mcpCatalog]);
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
  const connectionGroups = useMemo(() => {
    const groups = new Map<string, ConnectionEntry[]>();
    for (const connection of data.mcpConnections) {
      const group = groups.get(connection.catalogItemId) ?? [];
      group.push(connection);
      groups.set(connection.catalogItemId, group);
    }
    return Array.from(groups.values()).sort((left, right) =>
      left[0]!.catalogDisplayName.localeCompare(right[0]!.catalogDisplayName),
    );
  }, [data.mcpConnections]);
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

  const editingConnection = editingConnectionId ? data.mcpConnections.find((connection) => connection.id === editingConnectionId) : undefined;
  const selectedCandidate = data.mcpCatalog.find((item) => item.id === selectedCatalogId);
  const selected = editingConnection && selectedCandidate
    ? selectedCandidate
    : selectedCandidate && filteredCatalog.includes(selectedCandidate)
      ? selectedCandidate
      : filteredCatalog[0];
  const selectedRuntime = onlineRuntimes.find((r) => r.id === selectedRuntimeId) ?? onlineRuntimes[0];
  const formRuntimes = editingConnection
    ? data.runtimes.filter((runtime) => runtime.id === editingConnection.runtimeId)
    : onlineRuntimes;
  const formRuntimeId = editingConnection?.runtimeId ?? selectedRuntime?.id ?? "";
  const targetRuntime = editingConnection
    ? data.runtimes.find((runtime) => runtime.id === editingConnection.runtimeId)
    : selectedRuntime;
  const supportsSelectedTransport = selected?.transport === "streamable_http" || selected?.transport === "managed_stdio";
  const requiredRuntimeApp = selected?.requiredRuntimeApp;
  const requiredRuntimeInstallation = requiredRuntimeApp && targetRuntime
    ? data.installedApps.find((app) =>
        app.runtimeId === targetRuntime.id &&
        app.source === requiredRuntimeApp.source &&
        app.name === requiredRuntimeApp.name,
      )
    : undefined;
  const requiredRuntimeAppReady = !requiredRuntimeApp || Boolean(
    requiredRuntimeInstallation?.status === "installed" &&
    requiredRuntimeInstallation.enabled &&
    requiredRuntimeInstallation.version === requiredRuntimeApp.version,
  );
  const requiredRuntimeAppOperationActive = Boolean(requiredRuntimeApp && targetRuntime && data.operations.some((operation) =>
    operation.runtimeId === targetRuntime.id &&
    operation.appSource === requiredRuntimeApp.source &&
    operation.appName === requiredRuntimeApp.name &&
    isActiveCapabilityOperationStatus(operation.status),
  ));
  const requiredRuntimeCatalogApp = requiredRuntimeApp
    ? data.catalog.find((item) => item.source === requiredRuntimeApp.source && item.name === requiredRuntimeApp.name)
    : undefined;
  const requiredRuntimeAppInstallability = requiredRuntimeCatalogApp && targetRuntime
    ? projectRuntimeAppInstallability(requiredRuntimeCatalogApp.installability, targetRuntime.cliReadiness)
    : undefined;
  const requiresHighRiskConfirmation = Boolean(selected && (
    !editingConnection
      ? selected.risk === "high" || selected.declaredTools.some((tool) => tool.risk === "high" && approvedTools.has(tool.name))
      : selected.declaredTools.some((tool) => tool.risk === "high" && approvedTools.has(tool.name) && !editingConnection.approvedTools.includes(tool.name))
  ));
  const connectionConfigurationReady = Boolean(selected && endpoint.trim().length > 0
    && allConfigurationFieldsFilled(selected, nonSecretParams)
    && (editingConnection || allSecretsFilled(selected, secrets)));
  const toolPermissionsReady = !requiresHighRiskConfirmation || confirmHighRisk;

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
    if (![...data.mcpOperations, ...data.operations].some((op) => isActiveCapabilityOperationStatus(op.status))) return;
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
    if (!requiredRuntimeApp || !targetRuntime || targetRuntime.status !== "online") return;
    runAction(() => requestRuntimeAppOperationAction({
      runtimeId: targetRuntime.id,
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
                    {transports.map((transport) => <option key={transport} value={transport}>{transport}</option>)}
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

              <details className="mcp-tool-scope" open={selected.declaredTools.length <= 6}>
                <summary className="mcp-tool-scope__summary">
                  <span className="mcp-section-label">{tx("工具范围", "Tool scope")}</span>
                  <span>{tx(`${approvedTools.size}/${selected.declaredTools.length} 个工具已选择`, `${approvedTools.size}/${selected.declaredTools.length} tools selected`)}</span>
                </summary>
                <div className="mcp-tool-scope__list">
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
              </details>

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

              {selected.transport === "managed_stdio" ? (
                <ManagedMcpSetupProgress
                  configurationReady={connectionConfigurationReady}
                  dependencyReady={requiredRuntimeAppReady}
                  dependencyRequired={Boolean(requiredRuntimeApp)}
                  permissionsReady={toolPermissionsReady}
                  runtimeReady={Boolean(targetRuntime?.status === "online" && targetRuntime.mcpEligible)}
                  tx={tx}
                />
              ) : null}

              <div className="market-action-row">
                <button
                  className="primary-button"
                  disabled={isPending || !data.canManage || !supportsSelectedTransport || !targetRuntime || targetRuntime.status !== "online" || !targetRuntime.mcpEligible || requiredRuntimeAppOperationActive || (requiredRuntimeAppReady ? !isSubmittable() : requiredRuntimeAppInstallability?.status !== "installable")}
                  onClick={requiredRuntimeAppReady ? submitConnection : installRequiredRuntimeApp}
                  type="button"
                >
                  <AppIcon name={requiredRuntimeAppReady ? "plus" : "download"} />
                  <span>{requiredRuntimeAppOperationActive
                    ? tx("正在安装依赖 CLI", "Installing dependency CLI")
                    : !requiredRuntimeAppReady
                      ? tx("继续：安装依赖 CLI", "Continue: install dependency CLI")
                      : editingConnection
                        ? tx("更新并重新验证", "Update and re-verify")
                        : selected.transport === "managed_stdio"
                          ? tx("继续：验证并连接", "Continue: verify and connect")
                          : tx("配置并连接", "Configure and connect")}</span>
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
              {requiredRuntimeApp && !requiredRuntimeAppReady && requiredRuntimeAppInstallability?.status !== "installable" ? (
                <p className="panel-note panel-note--danger">{runtimeAppInstallabilityReason(requiredRuntimeAppInstallability?.code ?? "runtime_app.catalog_item_missing", tx)}</p>
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
            <p>{tx("按服务集中管理每个 Runtime 的独立连接。", "Manage each runtime connection, grouped by service.")}</p>
          </div>
          <div className="mcp-connections-summary" aria-label={tx(
            `${connectionGroups.length} 个服务，${data.mcpConnections.length} 个 Runtime 连接`,
            `${connectionGroups.length} services, ${data.mcpConnections.length} runtime connections`,
          )}>
            <span><strong>{connectionGroups.length}</strong>{tx("个服务", "services")}</span>
            <span><strong>{data.mcpConnections.length}</strong>{tx("个 Runtime 连接", "runtime connections")}</span>
          </div>
        </div>
        {data.mcpConnections.length === 0 ? (
          <p className="market-empty">{tx("尚未连接 MCP 服务。", "No MCP connections yet.")}</p>
        ) : (
          <ul className="mcp-service-group-list">
            {connectionGroups.map((connections) => {
              const service = connections[0]!;
              return (
                <li
                  aria-label={tx(
                    `${service.catalogDisplayName}，${connections.length} 个 Runtime 连接`,
                    `${service.catalogDisplayName}, ${connections.length} runtime connections`,
                  )}
                  className="mcp-service-group"
                  key={service.catalogItemId}
                >
                  <div className="mcp-service-group__heading">
                    <span className="mcp-service-group__icon"><AppIcon name="containers" /></span>
                    <div>
                      <strong>{service.catalogDisplayName}</strong>
                      <span>{service.transport} · {tx(`${connections.length} 个 Runtime`, `${connections.length} runtimes`)}</span>
                    </div>
                  </div>
                  <ul className="mcp-runtime-connection-list">
                    {connections.map((connection) => (
                      <ConnectionRow
                        key={connection.id}
                        connection={connection}
                        runtimeLabel={data.runtimes.find((runtime) => runtime.id === connection.runtimeId)?.label ?? connection.runtimeId}
                        canManage={data.canManage}
                        disabled={isPending}
                        onReverify={() => runAction(() => reverifyMcpConnectionAction({ connectionId: connection.id }))}
                        onDisable={() => runAction(() => disableMcpConnectionAction({ connectionId: connection.id }))}
                        onEnable={() => runAction(() => enableMcpConnectionAction({ connectionId: connection.id }))}
                        onRemove={() => {
                          setRemovingConnectionId(connection.id);
                          setRemovalStrategy("prohibit_new_jobs");
                        }}
                        onManage={() => manageConnection(connection)}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {showCreateCatalog ? (
        <CreateMcpCatalogModal
          onCancel={() => setShowCreateCatalog(false)}
          onConfirm={createCatalogItem}
          pending={isPending}
          privateCliReleases={data.catalog
            .filter((item): item is typeof item & { source: "workspace_private" } => item.source === "workspace_private")
            .map((item) => ({
              source: item.source,
              name: item.name,
              displayName: item.displayName,
              version: item.version,
              entryPoint: item.entryPoint,
            }))}
        />
      ) : null}
      {removingConnectionId ? (
        <McpRemovalDialog
          connection={data.mcpConnections.find((connection) => connection.id === removingConnectionId)!}
          pending={isPending}
          strategy={removalStrategy}
          onCancel={() => setRemovingConnectionId(null)}
          onStrategyChange={setRemovalStrategy}
          onConfirm={() => {
            const connectionId = removingConnectionId;
            setRemovingConnectionId(null);
            runAction(() => removeMcpConnectionAction({ connectionId, strategy: removalStrategy }));
          }}
        />
      ) : null}
    </div>
  );
}

function McpRemovalDialog(props: {
  connection: ConnectionEntry;
  pending: boolean;
  strategy: "prohibit_new_jobs" | "cancel_running_jobs";
  onCancel: () => void;
  onStrategyChange: (strategy: "prohibit_new_jobs" | "cancel_running_jobs") => void;
  onConfirm: () => void;
}) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLDivElement>(props.onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <div aria-labelledby={labelId} aria-modal="true" className="modal-card modal-card--compact" ref={surfaceRef} role="dialog" tabIndex={-1}>
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("移除 MCP 连接", "Remove MCP connection")}</h3>
            <p>{props.connection.catalogDisplayName}</p>
          </div>
          <button aria-label={tx("关闭", "Close")} className="modal-close" onClick={props.onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <p className="modal-card__note">
            {tx("两种策略都会立即禁止新 Job，并永久保留历史 Job、用量和账单。", "Both strategies immediately block new jobs and permanently retain job, usage, and billing history.")}
          </p>
          <fieldset className="skill-install-risk-approvals">
            <legend>{tx("运行中 Job", "Running jobs")}</legend>
            <label className="skill-install-risk-option">
              <input checked={props.strategy === "prohibit_new_jobs"} name="mcp-removal-strategy" onChange={() => props.onStrategyChange("prohibit_new_jobs")} type="radio" />
              <span>{tx("继续执行，结算完成后移除连接", "Let them finish, then remove the connection")}</span>
            </label>
            <label className="skill-install-risk-option">
              <input checked={props.strategy === "cancel_running_jobs"} name="mcp-removal-strategy" onChange={() => props.onStrategyChange("cancel_running_jobs")} type="radio" />
              <span>{tx("请求取消，结算完成后移除连接", "Request cancellation, then remove the connection")}</span>
            </label>
          </fieldset>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" disabled={props.pending} onClick={props.onCancel} type="button">{tx("返回", "Back")}</button>
          <button className="action-button action-button--danger" disabled={props.pending} onClick={props.onConfirm} type="button">
            {props.pending ? tx("处理中...", "Processing...") : tx("确认移除", "Confirm removal")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionRow(props: {
  connection: ConnectionEntry;
  runtimeLabel: string;
  canManage: boolean;
  disabled: boolean;
  onReverify: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
  onManage: () => void;
}) {
  const { tx } = useLanguage();
  const { connection, runtimeLabel, canManage, disabled } = props;
  const params = useParams<{ workspaceSlug?: string }>();
  const workspaceSlug = params.workspaceSlug;
  const detailHref = workspaceSlug ? `/w/${workspaceSlug}/market/mcp-connections/${connection.id}` : undefined;
  return (
    <li aria-label={`${connection.catalogDisplayName} · ${runtimeLabel}`} className="mcp-connection-row">
      <div className="mcp-connection-head">
        <span className="mcp-runtime-identity">
          <span className="mcp-runtime-identity__icon"><AppIcon name="terminal" /></span>
          <span>
            <small>Runtime</small>
            <strong>{runtimeLabel}</strong>
          </span>
        </span>
        <span className={`status-chip status-chip--${statusTone(connection.status)}`}>{statusLabel(connection.status, tx)}</span>
      </div>
      <div className="mcp-connection-meta">
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
          <Link aria-label={tx(`查看 ${runtimeLabel} 的 ${connection.catalogDisplayName} 详情`, `View ${connection.catalogDisplayName} details for ${runtimeLabel}`)} className="modal-secondary-button" href={detailHref}>
            {tx("详情", "Details")}
          </Link>
        ) : null}
        <button aria-label={tx(`管理 ${runtimeLabel} 的 ${connection.catalogDisplayName} 配置`, `Manage ${connection.catalogDisplayName} configuration for ${runtimeLabel}`)} className="modal-secondary-button" disabled={disabled || !canManage} onClick={props.onManage} type="button">
          {tx("管理配置", "Manage configuration")}
        </button>
        <button aria-label={tx(`重新验证 ${runtimeLabel} 的 ${connection.catalogDisplayName}`, `Re-verify ${connection.catalogDisplayName} for ${runtimeLabel}`)} className="modal-secondary-button" disabled={disabled || !canManage || connection.status === "disabled"} onClick={props.onReverify} type="button">
          {tx("重新验证", "Re-verify")}
        </button>
        {connection.status === "disabled" ? (
          <button aria-label={tx(`启用 ${runtimeLabel} 的 ${connection.catalogDisplayName}`, `Enable ${connection.catalogDisplayName} for ${runtimeLabel}`)} className="modal-secondary-button" disabled={disabled || !canManage} onClick={props.onEnable} type="button">
            {tx("启用", "Enable")}
          </button>
        ) : (
          <button aria-label={tx(`停用 ${runtimeLabel} 的 ${connection.catalogDisplayName}`, `Disable ${connection.catalogDisplayName} for ${runtimeLabel}`)} className="modal-secondary-button" disabled={disabled || !canManage || connection.status === "disabled"} onClick={props.onDisable} type="button">
            {tx("停用", "Disable")}
          </button>
        )}
        <button aria-label={tx(`移除 ${runtimeLabel} 的 ${connection.catalogDisplayName}`, `Remove ${connection.catalogDisplayName} from ${runtimeLabel}`)} className="modal-secondary-button mcp-danger-button" disabled={disabled || !canManage} onClick={props.onRemove} type="button">
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
  return new Intl.DateTimeFormat(tx("zh-CN", "en-US"), { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function allSecretsFilled(catalog: CatalogEntry, secrets: Record<string, string>): boolean {
  return catalog.secretFields.every((field) => (secrets[field] ?? "").trim().length > 0);
}

function allConfigurationFieldsFilled(catalog: CatalogEntry, params: Record<string, string>): boolean {
  return catalog.configurationFields.every((field) => !field.required || (params[field.name] ?? "").trim().length > 0);
}
