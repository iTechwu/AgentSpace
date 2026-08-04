"use client";

import type { McpCatalogCategory, McpCatalogSource, RuntimeAppCatalogSource, RuntimeAppOperationType } from "@dofe-agent/db";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { requestRuntimeAppOperationAction, refreshRuntimeAppCatalogAction, syncRuntimeAppSkillAction } from "@/features/market/actions";
import { McpMarketPanel } from "@/features/market/mcp-market-panel";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction, type ActionToastResult } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";

const CLI_CATALOG_BATCH_SIZE = 24;

export interface MarketPageData {
  catalog: Array<{
    source: RuntimeAppCatalogSource;
    name: string;
    displayName: string;
    description: string;
    version: string;
    category: string;
    entryPoint: string;
    installStrategy: string;
    installCmd?: string;
    skillMd?: string;
    requiresText?: string;
    homepage?: string;
    risk: "low" | "medium" | "high";
  }>;
  catalogHealth: {
    itemCount: number;
    lastSyncedAt?: string;
    stale: boolean;
  };
  runtimes: Array<{
    id: string;
    label: string;
    provider: string;
    status: "online" | "offline";
    daemonKey: string;
    cliHubReady: boolean;
    /** Runtime can host the MCP gateway (provider has a validated one-shot MCP config path). */
    mcpEligible: boolean;
  }>;
  installedApps: Array<{
    runtimeId: string;
    source: RuntimeAppCatalogSource;
    name: string;
    status: string;
    enabled: boolean;
    version: string;
    entryPoint: string;
    lastError?: string;
    updatedAt?: string;
  }>;
  operations: Array<{
    id: string;
    runtimeId: string;
    appSource: RuntimeAppCatalogSource;
    appName: string;
    operation: RuntimeAppOperationType;
    status: string;
    createdAt: string;
    errorMessage?: string;
  }>;
  mcpCatalog: Array<{
    id: string;
    source: McpCatalogSource;
    slug: string;
    displayName: string;
    description: string;
    version: string;
    category: McpCatalogCategory;
    transport: "streamable_http" | "sse" | "managed_service" | "managed_stdio";
    risk: "low" | "medium" | "high";
    allowedHosts: string[];
    dataDomains: string[];
    declaredTools: Array<{ name: string; description: string; risk: "low" | "medium" | "high" }>;
    defaultApprovedTools: string[];
    secretFields: string[];
    configurationFields: Array<{ name: string; required: boolean; maxLength?: number }>;
    endpointTemplate?: string;
    documentationUrl?: string;
    requiredRuntimeApp?: { source: RuntimeAppCatalogSource; name: string; version: string };
  }>;
  mcpConnections: Array<{
    id: string;
    runtimeId: string;
    catalogItemId: string;
    catalogSlug: string;
    catalogDisplayName: string;
    status: string;
    transport: "streamable_http" | "sse" | "managed_service" | "managed_stdio";
    approvedTools: string[];
    declaredToolCount: number;
    lastVerifiedAt?: string;
    lastErrorCode?: string;
    lastErrorMessage?: string;
  }>;
  mcpOperations: Array<{
    id: string;
    runtimeId: string;
    connectionId: string;
    operation: "verify" | "enable" | "disable" | "remove";
    status: string;
    createdAt: string;
    errorMessage?: string;
  }>;
  canManage: boolean;
}

export function MarketPageClient({ data, onDataChanged }: { data: MarketPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab") === "mcp" ? "mcp" : "cli";
  const [tab, setTab] = useState<"cli" | "mcp">(requestedTab);

  useEffect(() => {
    setTab(requestedTab);
  }, [requestedTab]);

  function selectTab(next: "cli" | "mcp"): void {
    setTab(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "mcp") {
      params.set("tab", "mcp");
    } else {
      params.delete("tab");
    }
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  const installedAppCount = data.installedApps.filter((app) => app.status === "installed").length;
  const onlineRuntimeCount = data.runtimes.filter((runtime) => runtime.status === "online").length;

  return (
    <main className="market-page-shell">
      <section className="market-toolbar market-toolbar--hub">
        <div className="market-title-block">
          <span className="market-eyebrow">
            <AppIcon name="market" />
            {tx("能力资源", "Capability resources")}
          </span>
          <h1>{tx("应用与服务市场", "Apps & Services")}</h1>
          <p>{tx("在同一处发现、安装并管理 Runtime 的 CLI 应用与 MCP 服务。", "Discover, install, and manage CLI apps and MCP services for every runtime.")}</p>
        </div>
        <dl className="market-overview-stats" aria-label={tx("市场概览", "Market overview")}>
          <div>
            <dt>{tx("可用能力", "Available")}</dt>
            <dd>{data.catalog.length + data.mcpCatalog.length}</dd>
          </div>
          <div>
            <dt>{tx("已启用", "Enabled")}</dt>
            <dd>{installedAppCount + data.mcpConnections.length}</dd>
          </div>
          <div>
            <dt>{tx("在线 Runtime", "Online runtimes")}</dt>
            <dd>{onlineRuntimeCount}</dd>
          </div>
        </dl>
      </section>

      <div className="market-tab-switcher market-tab-switcher--market" role="tablist">
        <button
          aria-controls="cli-market-panel"
          aria-current={tab === "cli" ? "page" : undefined}
          aria-label={tx("CLI 市场", "CLI Market")}
          aria-selected={tab === "cli"}
          className={`market-tab${tab === "cli" ? " market-tab--active" : ""}`}
          onClick={() => selectTab("cli")}
          role="tab"
          type="button"
        >
          <AppIcon name="terminal" />
          <span>
            <strong>{tx("CLI 应用", "CLI apps")}</strong>
            <small>{tx(`${data.catalog.length} 个可安装应用`, `${data.catalog.length} available`)}</small>
          </span>
        </button>
        <button
          aria-controls="mcp-market-panel"
          aria-current={tab === "mcp" ? "page" : undefined}
          aria-label={tx("MCP 市场", "MCP Market")}
          aria-selected={tab === "mcp"}
          className={`market-tab${tab === "mcp" ? " market-tab--active" : ""}`}
          onClick={() => selectTab("mcp")}
          role="tab"
          type="button"
        >
          <AppIcon name="containers" />
          <span>
            <strong>{tx("MCP 服务", "MCP services")}</strong>
            <small>{tx(`${data.mcpCatalog.length} 个目录服务`, `${data.mcpCatalog.length} catalog services`)}</small>
          </span>
        </button>
      </div>

      {tab === "cli" ? (
        <CliHubPanel data={data} onDataChanged={onDataChanged} />
      ) : (
        <McpMarketPanel data={data} onDataChanged={onDataChanged} />
      )}
    </main>
  );
}

function CliHubPanel({ data, onDataChanged }: { data: MarketPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | RuntimeAppCatalogSource>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "not_installed" | "needs_attention">("all");
  const [selectedKey, setSelectedKey] = useState(`${data.catalog[0]?.source ?? ""}:${data.catalog[0]?.name ?? ""}`);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(data.runtimes[0]?.id ?? "");
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [visibleCatalogCount, setVisibleCatalogCount] = useState(CLI_CATALOG_BATCH_SIZE);
  const [isPending, startTransition] = useTransition();
  const onlineRuntimes = useMemo(() => data.runtimes.filter((runtime) => runtime.status === "online"), [data.runtimes]);

  const categories = useMemo(() => [
    "all",
    ...Array.from(new Set(data.catalog.map((item) => item.category || "uncategorized"))).sort((left, right) => left.localeCompare(right)),
  ], [data.catalog]);
  const sources = useMemo(() => Array.from(new Set(data.catalog.map((item) => item.source))).sort(), [data.catalog]);
  const installedRuntimeCount = useMemo(() => new Map(data.catalog.map((item) => {
    const runtimeIds = new Set(data.installedApps
      .filter((app) => app.source === item.source && app.name === item.name && app.status === "installed" && app.enabled)
      .map((app) => app.runtimeId));
    return [`${item.source}:${item.name}`, runtimeIds.size] as const;
  })), [data.catalog, data.installedApps]);
  const installationState = useMemo(() => new Map(data.catalog.map((item) => {
    const installs = data.installedApps.filter((app) => app.source === item.source && app.name === item.name);
    const state = installs.some((app) => app.status === "failed")
      ? "needs_attention"
      : installs.some((app) => app.status === "installed" && app.enabled)
        ? "installed"
        : "not_installed";
    return [`${item.source}:${item.name}`, state] as const;
  })), [data.catalog, data.installedApps]);
  const cliInstallationGroups = useMemo(() => {
    const groups = new Map<string, MarketPageData["installedApps"]>();
    for (const installation of data.installedApps) {
      const key = `${installation.source}:${installation.name}`;
      const group = groups.get(key) ?? [];
      group.push(installation);
      groups.set(key, group);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [data.installedApps]);
  const filteredCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    return data.catalog.filter((item) => {
      const categoryMatch = category === "all" || (item.category || "uncategorized") === category;
      const sourceMatch = sourceFilter === "all" || item.source === sourceFilter;
      const riskMatch = riskFilter === "all" || item.risk === riskFilter;
      const installMatch = installFilter === "all" || installationState.get(`${item.source}:${item.name}`) === installFilter;
      const queryMatch =
        !normalizedQuery ||
        `${item.name} ${item.displayName} ${item.description} ${item.entryPoint}`.toLocaleLowerCase("en-US").includes(normalizedQuery);
      return categoryMatch && sourceMatch && riskMatch && installMatch && queryMatch;
    });
  }, [category, data.catalog, installFilter, installationState, query, riskFilter, sourceFilter]);
  const selectedCandidate = data.catalog.find((item) => `${item.source}:${item.name}` === selectedKey);
  const selected = selectedCandidate && filteredCatalog.includes(selectedCandidate)
    ? selectedCandidate
    : filteredCatalog[0];
  const visibleCatalog = filteredCatalog.slice(0, visibleCatalogCount);
  const selectedRuntime = onlineRuntimes.find((runtime) => runtime.id === selectedRuntimeId) ?? onlineRuntimes[0];
  const selectedOperations = selected && selectedRuntime
    ? data.operations.filter((operation) =>
        operation.runtimeId === selectedRuntime.id &&
        operation.appSource === selected.source &&
        operation.appName === selected.name,
      )
    : [];
  const latestOperation = selectedOperations[0];
  const selectedInstall = selected && selectedRuntime
    ? data.installedApps.find((app) =>
        app.runtimeId === selectedRuntime.id &&
        app.source === selected.source &&
        app.name === selected.name,
      )
    : undefined;
  const selectedOperation = latestOperation && isActiveOperationStatus(latestOperation.status) ? latestOperation : undefined;
  const installStateLabel = selectedOperation?.status ?? selectedInstall?.status ?? latestOperation?.status ?? "not installed";
  const installStateTone = selectedOperation
    ? "warning"
    : selectedInstall?.status === "installed"
      ? "positive"
      : selectedInstall?.status === "failed" || latestOperation?.status === "failed"
        ? "danger"
        : "neutral";
  const operationError = latestOperation?.status === "failed" ? latestOperation.errorMessage : undefined;
  const installError = operationError || selectedInstall?.lastError;
  const installErrorMessage = installError ? formatRuntimeAppError(installError, tx) : undefined;

  useEffect(() => {
    if (!data.operations.some((operation) => isActiveOperationStatus(operation.status))) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      refreshWorkspaceModule(onDataChanged, router);
    }, 2_500);
    return () => window.clearTimeout(timeoutId);
  }, [data.operations, onDataChanged, router]);

  useEffect(() => {
    setVisibleCatalogCount(CLI_CATALOG_BATCH_SIZE);
  }, [category, installFilter, query, riskFilter, sourceFilter]);

  function runAction(work: () => Promise<ActionToastResult<void>>): void {
    startTransition(async () => {
      await runToastAction({
        action: work,
        onSuccess: async () => {
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: {
          zh: "请求失败，请稍后重试。",
          en: "Request failed. Please try again.",
        },
      });
    });
  }

  function requestOperation(operation: RuntimeAppOperationType): void {
    if (!selected || !selectedRuntime) return;
    runAction(() => requestRuntimeAppOperationAction({
      runtimeId: selectedRuntime.id,
      source: selected.source,
      name: selected.name,
      operation,
      confirmHighRisk,
    }));
  }

  return (
    <div aria-labelledby="cli-market-heading" className="market-tab-panel" id="cli-market-panel" role="tabpanel">
      <div className="market-panel-header">
        <div>
          <h2 id="cli-market-heading">{tx("CLI 应用", "CLI apps")}</h2>
          <p>{tx("选择应用并安装到在线 Runtime，安装后可同步对应 Skill。", "Choose an app to install on an online runtime, then sync its skill when available.")}</p>
        </div>
        <button
          className="action-button"
          disabled={isPending || !data.canManage}
          onClick={() => runAction(refreshRuntimeAppCatalogAction)}
          type="button"
        >
          <AppIcon name="refresh" />
          <span>{tx("刷新目录", "Refresh catalog")}</span>
        </button>
      </div>

      {data.catalog.length === 0 ? (
        <MarketEmptyState
          description={tx("目录中还没有可安装的 CLI 应用，请刷新目录后重试。", "There are no installable CLI apps in the catalog yet. Refresh the catalog to try again.")}
          title={tx("CLI 应用目录为空", "The CLI catalog is empty")}
        />
      ) : (
        <div className="market-workbench">
          <aside className="market-catalog-panel" aria-label={tx("应用筛选与目录", "App filters and catalog")}>
            <div className="market-catalog-tools">
              <label className="market-search">
                <AppIcon name="search" />
                <input
                  aria-label={tx("搜索应用", "Search apps")}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={tx("搜索应用、命令或描述", "Search apps, commands, or descriptions")}
                  value={query}
                />
              </label>
              <div className="mcp-filter-heading">
                <strong>{tx("筛选", "Filters")}</strong>
                <button
                  disabled={category === "all" && sourceFilter === "all" && riskFilter === "all" && installFilter === "all" && !query}
                  onClick={() => { setQuery(""); setCategory("all"); setSourceFilter("all"); setRiskFilter("all"); setInstallFilter("all"); }}
                  type="button"
                >
                  {tx("清除", "Clear")}
                </button>
              </div>
              <div className="mcp-filter-grid">
                <label className="form-field">
                  <span>{tx("类别", "Category")}</span>
                  <select onChange={(event) => setCategory(event.currentTarget.value)} value={category}>
                    {categories.map((item) => <option key={item} value={item}>{item === "all" ? tx("全部类别", "All categories") : item}</option>)}
                  </select>
                </label>
                <label className="form-field">
                  <span>{tx("来源", "Source")}</span>
                  <select onChange={(event) => setSourceFilter(event.currentTarget.value as typeof sourceFilter)} value={sourceFilter}>
                    <option value="all">{tx("全部来源", "All sources")}</option>
                    {sources.map((source) => <option key={source} value={source}>{source}</option>)}
                  </select>
                </label>
                <label className="form-field">
                  <span>{tx("安装状态", "Install status")}</span>
                  <select onChange={(event) => setInstallFilter(event.currentTarget.value as typeof installFilter)} value={installFilter}>
                    <option value="all">{tx("全部状态", "All statuses")}</option>
                    <option value="installed">{tx("已安装", "Installed")}</option>
                    <option value="not_installed">{tx("未安装", "Not installed")}</option>
                    <option value="needs_attention">{tx("需要处理", "Needs attention")}</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>{tx("风险", "Risk")}</span>
                  <select onChange={(event) => setRiskFilter(event.currentTarget.value as typeof riskFilter)} value={riskFilter}>
                    <option value="all">{tx("全部风险", "All risks")}</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="market-catalog-meta">
              <strong>{tx("应用目录", "App catalog")}</strong>
              <span>{tx(`${filteredCatalog.length} 个结果`, `${filteredCatalog.length} results`)}</span>
            </div>
            <section className="market-app-list" aria-label={tx("CLI-Hub 应用目录", "CLI-Hub app catalog")}>
              {visibleCatalog.map((item) => {
                const active = selected && item.source === selected.source && item.name === selected.name;
                const installedCount = installedRuntimeCount.get(`${item.source}:${item.name}`) ?? 0;
                const state = installationState.get(`${item.source}:${item.name}`) ?? "not_installed";
                return (
                  <button
                    className={`market-app-row${active ? " market-app-row--active" : ""}`}
                    key={`${item.source}:${item.name}`}
                    onClick={() => {
                      setSelectedKey(`${item.source}:${item.name}`);
                      setConfirmHighRisk(false);
                    }}
                    type="button"
                  >
                    <span className={`market-risk-dot market-risk-dot--${item.risk}`} />
                    <span className="market-app-identity">
                      <strong>{item.displayName}</strong>
                      <small>{item.description || item.name}</small>
                    </span>
                    <span className="market-app-meta">
                      <strong>{item.entryPoint || item.name}</strong>
                      <small>
                        {state === "needs_attention" ? tx("需要处理", "Needs attention") : state === "installed" ? tx("已安装", "Installed") : tx("未安装", "Not installed")}
                        {installedCount > 0 ? tx(` · ${installedCount} 个 Runtime`, ` · ${installedCount} runtimes`) : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
              {filteredCatalog.length === 0 ? (
                <div className="market-filter-empty">
                  <AppIcon name="search" />
                  <strong>{tx("没有匹配的应用", "No matching apps")}</strong>
                  <button onClick={() => { setQuery(""); setCategory("all"); setSourceFilter("all"); setRiskFilter("all"); setInstallFilter("all"); }} type="button">
                    {tx("清除筛选", "Clear filters")}
                  </button>
                </div>
              ) : null}
              {visibleCatalog.length < filteredCatalog.length ? (
                <div className="market-catalog-load-more">
                  <span>{tx(`已显示 ${visibleCatalog.length}/${filteredCatalog.length}`, `Showing ${visibleCatalog.length}/${filteredCatalog.length}`)}</span>
                  <button
                    className="modal-secondary-button"
                    onClick={() => setVisibleCatalogCount((count) => count + CLI_CATALOG_BATCH_SIZE)}
                    type="button"
                  >
                    {tx("加载更多应用", "Load more apps")}
                  </button>
                </div>
              ) : null}
            </section>
          </aside>

          <aside className="market-detail-panel" aria-label={tx("应用详情", "App details")}>
            {selected ? (
              <>
                <div className="market-detail-heading">
                  <div>
                    <span className="market-detail-kicker">CLI · {selected.category || "uncategorized"}</span>
                    <h2>{selected.displayName}</h2>
                    <p>{selected.description || selected.name}</p>
                  </div>
                  <span className={`status-chip status-chip--${selected.risk === "high" ? "danger" : selected.risk === "medium" ? "warning" : "positive"}`}>
                    {selected.risk}
                  </span>
                </div>

                <div className="market-facts-grid">
                  <Fact label="Source" value={selected.source === "clihub_harness" ? "CLI-Anything harness" : "Public CLI"} />
                  <Fact label="Version" value={selected.version || "unknown"} />
                  <Fact label="Entry point" value={selected.entryPoint || "not declared"} />
                  <Fact label="Strategy" value={selected.installStrategy || "cli_hub"} />
                  <Fact label="Skill" value={selected.skillMd ? "SKILL.md declared" : "not declared"} />
                  <Fact label="Requires" value={selected.requiresText || "none declared"} />
                </div>

                <div className="market-runtime-box">
                  <label className="form-field">
                    <span>{tx("目标 runtime", "Target runtime")}</span>
                    <select
                      disabled={isPending || onlineRuntimes.length === 0}
                      onChange={(event) => setSelectedRuntimeId(event.currentTarget.value)}
                      value={selectedRuntime?.id ?? ""}
                    >
                      {onlineRuntimes.map((runtime) => (
                        <option key={runtime.id} value={runtime.id}>
                          {runtime.label} · {runtime.status} · {runtimeAppReadinessLabel(runtime, selected, data.installedApps, tx)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="market-install-state">
                    <span className={`status-chip status-chip--${installStateTone}`}>
                      {installStateLabel}
                    </span>
                    {installErrorMessage ? (
                      <div className="market-install-error" role="alert">
                        <span>{tx("错误详情", "Error details")}</span>
                        <pre>{installErrorMessage}</pre>
                      </div>
                    ) : null}
                  </div>
                </div>

                {selected.risk === "high" ? (
                  <label className="market-confirm-risk">
                    <input
                      checked={confirmHighRisk}
                      onChange={(event) => setConfirmHighRisk(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>{tx("确认 high-risk 安装计划", "Confirm high-risk install plan")}</span>
                  </label>
                ) : null}

                <div className="market-action-row">
                  <button
                    className="primary-button"
                    disabled={isPending || !data.canManage || !selectedRuntime || Boolean(selectedOperation) || (selected.risk === "high" && !confirmHighRisk)}
                    onClick={() => requestOperation(selectedInstall?.status === "installed" ? "update" : "install")}
                    type="button"
                  >
                    <AppIcon name="download" />
                    <span>{selectedInstall?.status === "installed" ? tx("更新", "Update") : tx("安装", "Install")}</span>
                  </button>
                  <button
                    className="modal-secondary-button"
                    disabled={isPending || !data.canManage || !selectedRuntime || selectedInstall?.status !== "installed"}
                    onClick={() => requestOperation("uninstall")}
                    type="button"
                  >
                    <AppIcon name="trash" />
                    <span>{tx("卸载", "Uninstall")}</span>
                  </button>
                  <button
                    className="modal-secondary-button"
                    disabled={isPending || !data.canManage || !selectedRuntime || selectedInstall?.status !== "installed" || !selected.skillMd}
                    onClick={() => runAction(() => syncRuntimeAppSkillAction({
                      runtimeId: selectedRuntime!.id,
                      source: selected.source,
                      name: selected.name,
                    }))}
                    type="button"
                  >
                    <AppIcon name="skills" />
                    <span>{tx("同步 Skill", "Sync skill")}</span>
                  </button>
                </div>

                {selected.installCmd ? (
                  <pre className="market-command-preview">{selected.installCmd}</pre>
                ) : null}
              </>
            ) : null}
          </aside>
        </div>
      )}

      <section className="mcp-connections-section" aria-label={tx("CLI 安装记录", "CLI installations")}>
        <div className="mcp-connections-heading">
          <div>
            <h3>{tx("已安装应用", "Installed apps")}</h3>
            <p>{tx("按应用查看每个 Runtime 的安装状态。", "Review each runtime installation, grouped by app.")}</p>
          </div>
          <div className="mcp-connections-summary" aria-label={tx(
            `${cliInstallationGroups.length} 个应用，${data.installedApps.length} 条 Runtime 安装`,
            `${cliInstallationGroups.length} apps, ${data.installedApps.length} runtime installations`,
          )}>
            <span><strong>{cliInstallationGroups.length}</strong>{tx("个应用", "apps")}</span>
            <span><strong>{data.installedApps.length}</strong>{tx("条 Runtime 安装", "runtime installations")}</span>
          </div>
        </div>
        {cliInstallationGroups.length === 0 ? (
          <p className="market-empty">{tx("尚未安装 CLI 应用。", "No CLI apps installed yet.")}</p>
        ) : (
          <ul className="mcp-service-group-list">
            {cliInstallationGroups.map(([key, installations]) => {
              const catalog = data.catalog.find((item) => `${item.source}:${item.name}` === key);
              const displayName = catalog?.displayName ?? installations[0]!.name;
              return (
                <li className="mcp-service-group" key={key}>
                  <div className="mcp-service-group__heading">
                    <span className="mcp-service-group__icon"><AppIcon name="terminal" /></span>
                    <div>
                      <strong>{displayName}</strong>
                      <span>{installations[0]!.source} · {tx(`${installations.length} 个 Runtime`, `${installations.length} runtimes`)}</span>
                    </div>
                  </div>
                  <ul className="mcp-runtime-connection-list">
                    {installations.map((installation) => {
                      const runtimeLabel = data.runtimes.find((runtime) => runtime.id === installation.runtimeId)?.label ?? installation.runtimeId;
                      return (
                        <li aria-label={`${displayName} · ${runtimeLabel}`} className="mcp-connection-row" key={`${key}:${installation.runtimeId}`}>
                          <div className="mcp-connection-head">
                            <span className="mcp-runtime-identity">
                              <span className="mcp-runtime-identity__icon"><AppIcon name="containers" /></span>
                              <span><small>Runtime</small><strong>{runtimeLabel}</strong></span>
                            </span>
                            <span className={`status-chip status-chip--${installation.status === "installed" && installation.enabled ? "positive" : installation.status === "failed" ? "danger" : "neutral"}`}>
                              {installation.enabled ? installation.status : tx("已停用", "Disabled")}
                            </span>
                          </div>
                          <div className="mcp-connection-meta">
                            <span>{tx("版本", "Version")}: {installation.version || tx("未知", "Unknown")}</span>
                            <span>{tx("入口", "Entry")}: {installation.entryPoint || installation.name}</span>
                            {installation.updatedAt ? <span>{tx("更新于", "Updated")}: <time dateTime={installation.updatedAt}>{formatMarketTimestamp(installation.updatedAt)}</time></span> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function MarketEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <section className="market-empty-state">
      <span className="market-empty-icon"><AppIcon name="market" /></span>
      <h3>{title}</h3>
      <p>{description}</p>
    </section>
  );
}

function isActiveOperationStatus(status: string): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

function formatRuntimeAppError(error: string, tx: (zh: string, en: string) => string): string {
  switch (error.trim()) {
    case "managed_runtime.docker_network_required":
      return tx(
        "目标 Runtime 缺少隔离安装网络。请在执行引擎中更新托管节点配置并重启节点后重试。",
        "The target runtime has no isolated install network. Update the managed node configuration, restart it, and try again.",
      );
    case "managed_runtime.docker_network_not_isolated":
      return tx(
        "目标 Runtime 使用了非隔离 Docker 网络。请配置用户自定义网络后重试。",
        "The target runtime uses a non-isolated Docker network. Configure a user-defined network and try again.",
      );
    case "managed_runtime.mcp_egress_network_required":
      return tx(
        "目标 Runtime 未连接受控出口网络。请完成节点出口策略配置后重试。",
        "The target runtime is not connected to the controlled egress network. Complete its egress policy configuration and try again.",
      );
    case "spawn python3 ENOENT":
      return tx(
        "目标 Runtime 的旧安装执行器缺少 Python。请更新并重启托管节点后重试。",
        "The target runtime uses an outdated installer without Python. Update and restart the managed node, then try again.",
      );
    default: {
      const normalized = error.toLowerCase();
      if (normalized.includes("docker run") || normalized.includes("traceback")) {
        return tx(
          "Runtime 内的安装或验证命令执行失败。请检查应用依赖与网络策略后重试；完整诊断已保留在执行记录中。",
          "The install or verification command failed inside the Runtime. Check app dependencies and network policy, then retry; full diagnostics remain in the execution record.",
        );
      }
      return error;
    }
  }
}

function runtimeAppReadinessLabel(
  runtime: MarketPageData["runtimes"][number],
  app: MarketPageData["catalog"][number],
  installedApps: MarketPageData["installedApps"],
  tx: (zh: string, en: string) => string,
): string {
  const installed = installedApps.some((item) =>
    item.runtimeId === runtime.id &&
    item.source === app.source &&
    item.name === app.name &&
    item.status === "installed" &&
    item.enabled,
  );
  if (installed) return tx("应用已安装", "App installed");
  if (runtime.cliHubReady) return tx("CLI-Hub 已就绪", "CLI-Hub ready");
  return tx("首次安装自动准备", "Bootstrap on first install");
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="market-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatMarketTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
