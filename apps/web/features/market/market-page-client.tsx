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
            <small>{tx(`${data.mcpCatalog.length} 个已审核服务`, `${data.mcpCatalog.length} reviewed`)}</small>
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
  const [selectedKey, setSelectedKey] = useState(`${data.catalog[0]?.source ?? ""}:${data.catalog[0]?.name ?? ""}`);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(data.runtimes[0]?.id ?? "");
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [isPending, startTransition] = useTransition();
  const onlineRuntimes = useMemo(() => data.runtimes.filter((runtime) => runtime.status === "online"), [data.runtimes]);

  const categories = useMemo(() => [
    "all",
    ...Array.from(new Set(data.catalog.map((item) => item.category || "uncategorized"))).sort((left, right) => left.localeCompare(right)),
  ], [data.catalog]);
  const filteredCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    return data.catalog.filter((item) => {
      const categoryMatch = category === "all" || (item.category || "uncategorized") === category;
      const queryMatch =
        !normalizedQuery ||
        `${item.name} ${item.displayName} ${item.description} ${item.entryPoint}`.toLocaleLowerCase("en-US").includes(normalizedQuery);
      return categoryMatch && queryMatch;
    });
  }, [category, data.catalog, query]);
  const selected = data.catalog.find((item) => `${item.source}:${item.name}` === selectedKey) ?? filteredCatalog[0] ?? data.catalog[0];
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
              <div className="market-category-list" aria-label={tx("应用类别", "App categories")}>
                {categories.map((item) => (
                  <button
                    aria-pressed={category === item}
                    className={`market-category-button${category === item ? " market-category-button--active" : ""}`}
                    key={item}
                    onClick={() => setCategory(item)}
                    type="button"
                  >
                    <span>{item === "all" ? tx("全部", "All") : item}</span>
                    <span>{item === "all" ? data.catalog.length : data.catalog.filter((app) => (app.category || "uncategorized") === item).length}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="market-catalog-meta">
              <strong>{tx("应用目录", "App catalog")}</strong>
              <span>{tx(`${filteredCatalog.length} 个结果`, `${filteredCatalog.length} results`)}</span>
            </div>
            <section className="market-app-list" aria-label={tx("CLI-Hub 应用目录", "CLI-Hub app catalog")}>
              {filteredCatalog.map((item) => {
                const active = selected && item.source === selected.source && item.name === selected.name;
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
                      <small>{item.category || "uncategorized"}</small>
                    </span>
                  </button>
                );
              })}
              {filteredCatalog.length === 0 ? (
                <div className="market-filter-empty">
                  <AppIcon name="search" />
                  <strong>{tx("没有匹配的应用", "No matching apps")}</strong>
                  <button onClick={() => { setQuery(""); setCategory("all"); }} type="button">
                    {tx("清除筛选", "Clear filters")}
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
                          {runtime.label} · {runtime.status} · {runtime.cliHubReady ? "cli-hub ready" : "bootstrap needed"}
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="market-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
