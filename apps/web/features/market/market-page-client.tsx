"use client";

import type { RuntimeAppCatalogSource, RuntimeAppOperationType } from "@dofe-agent/db";
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
    slug: string;
    displayName: string;
    description: string;
    version: string;
    transport: "streamable_http" | "sse" | "managed_service" | "managed_stdio";
    risk: "low" | "medium" | "high";
    allowedHosts: string[];
    dataDomains: string[];
    declaredTools: Array<{ name: string; description: string; risk: "low" | "medium" | "high" }>;
    defaultApprovedTools: string[];
    secretFields: string[];
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
    endpoint: string;
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
  const [tab, setTab] = useState<"cli" | "mcp">(() => (searchParams.get("tab") === "mcp" ? "mcp" : "cli"));

  function selectTab(next: "cli" | "mcp"): void {
    setTab(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "mcp") {
      params.set("tab", "mcp");
    } else {
      params.delete("tab");
    }
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  return (
    <main className="market-page-shell">
      <section className="market-toolbar">
        <div>
          <h1>{tx("应用市场", "App Market")}</h1>
          <p>{tx("为 Runtime 安装 CLI 应用，或连接审核过的 MCP 服务。", "Install CLI apps or connect reviewed MCP services to your runtimes.")}</p>
        </div>
      </section>

      <div className="market-tab-switcher" role="tablist">
        <button
          aria-current={tab === "cli" ? "page" : undefined}
          className={`market-tab${tab === "cli" ? " market-tab--active" : ""}`}
          onClick={() => selectTab("cli")}
          role="tab"
          type="button"
        >
          {tx("CLI 市场", "CLI Market")}
        </button>
        <button
          aria-current={tab === "mcp" ? "page" : undefined}
          className={`market-tab${tab === "mcp" ? " market-tab--active" : ""}`}
          onClick={() => selectTab("mcp")}
          role="tab"
          type="button"
        >
          {tx("MCP 市场", "MCP Market")}
          <span className="market-tab-suffix">MCP 中心</span>
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
    <div className="market-tab-panel">
      <div className="market-panel-actions">
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

      <div className="market-workbench">
        <aside className="market-filter-panel" aria-label={tx("应用筛选", "App filters")}>
          <label className="market-search">
            <AppIcon name="search" />
            <input
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={tx("搜索 app、entry point、描述", "Search app, entry point, description")}
              value={query}
            />
          </label>
          <div className="market-category-list">
            {categories.map((item) => (
              <button
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
        </aside>

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
                <strong>{item.displayName}</strong>
                <span>{item.entryPoint || item.name}</span>
                <small>{item.category || "uncategorized"}</small>
              </button>
            );
          })}
        </section>

        <aside className="market-detail-panel" aria-label={tx("应用详情", "App details")}>
          {selected ? (
            <>
              <div className="market-detail-heading">
                <div>
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
                  {installError ? (
                    <div className="market-install-error" role="alert">
                      <span>{tx("错误详情", "Error details")}</span>
                      <pre>{installError}</pre>
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
          ) : (
            <p>{tx("目录为空，请刷新 catalog。", "Catalog is empty; refresh the catalog.")}</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function isActiveOperationStatus(status: string): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="market-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
