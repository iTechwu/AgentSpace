"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestRuntimeAppOperationAction } from "@/features/market/actions";
import { removeMcpConnectionAction, requestMcpConnectionAction, reverifyMcpConnectionAction } from "@/features/market/mcp-actions";
import type { MarketPageData } from "@/features/market/market-page-client";
import {
  isActiveCapabilityOperationStatus,
  mcpOperationStageLabel,
  projectRuntimeAppInstallability,
  runtimeAppOperationStageLabel,
  runtimeAppInstallabilityReason,
  runtimeAppInstallabilityStatusLabel,
} from "@/features/market/capability-presentation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction, type ActionToastResult } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import { ManagedMcpSetupProgress } from "@/features/market/managed-mcp-setup-progress";

type CliCatalogEntry = MarketPageData["catalog"][number];
type McpCatalogEntry = MarketPageData["mcpCatalog"][number];

export function RuntimeCapabilitiesPanel({
  data,
  runtimeId,
  runtimeName,
  runtimeStatus,
  workspaceSlug,
}: {
  data: MarketPageData;
  runtimeId: string;
  runtimeName: string;
  runtimeStatus: "online" | "offline";
  workspaceSlug: string;
}) {
  const { language, tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const [activeTab, setActiveTab] = useState<"cli" | "mcp">("cli");
  const [capabilityView, setCapabilityView] = useState<"current" | "catalog" | "history">("current");
  const [query, setQuery] = useState("");
  const [cliRiskConfirmation, setCliRiskConfirmation] = useState<string | null>(null);
  const [cliRiskConfirmed, setCliRiskConfirmed] = useState(false);
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [nonSecretParams, setNonSecretParams] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [approvedTools, setApprovedTools] = useState<Set<string>>(new Set());
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [isPending, startTransition] = useTransition();

  const runtime = data.runtimes.find((item) => item.id === runtimeId);
  const installedApps = useMemo(() => data.installedApps.filter((item) => item.runtimeId === runtimeId), [data.installedApps, runtimeId]);
  const mcpConnections = useMemo(() => data.mcpConnections.filter((item) => item.runtimeId === runtimeId), [data.mcpConnections, runtimeId]);
  const cliOperations = useMemo(() => data.operations.filter((item) => item.runtimeId === runtimeId), [data.operations, runtimeId]);
  const mcpOperations = useMemo(() => data.mcpOperations.filter((item) => item.runtimeId === runtimeId), [data.mcpOperations, runtimeId]);
  const installedAppKeys = useMemo(() => new Set(
    installedApps
      .filter((item) => item.status === "installed" && item.enabled)
      .map((item) => `${item.source}:${item.name}`),
  ), [installedApps]);
  const connectedMcpIds = useMemo(() => new Set(
    mcpConnections.filter((item) => item.status === "ready").map((item) => item.catalogItemId),
  ), [mcpConnections]);
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleCli = data.catalog.filter((item) =>
    (capabilityView === "catalog" || installedAppKeys.has(`${item.source}:${item.name}`))
    && (!normalizedQuery || `${item.displayName} ${item.name} ${item.description} ${item.entryPoint}`.toLocaleLowerCase("en-US").includes(normalizedQuery)),
  );
  const visibleMcp = data.mcpCatalog.filter((item) =>
    (capabilityView === "catalog" || connectedMcpIds.has(item.id))
    && (!normalizedQuery || `${item.displayName} ${item.slug} ${item.description}`.toLocaleLowerCase("en-US").includes(normalizedQuery)),
  );
  const selectedMcp = selectedMcpId ? data.mcpCatalog.find((item) => item.id === selectedMcpId) : undefined;

  useEffect(() => {
    if (![...cliOperations, ...mcpOperations].some((operation) => isActiveCapabilityOperationStatus(operation.status))) return;
    const timeoutId = window.setTimeout(() => router.refresh(), 2_500);
    return () => window.clearTimeout(timeoutId);
  }, [cliOperations, mcpOperations, router]);

  function runAction(work: () => Promise<ActionToastResult<void>>): void {
    startTransition(async () => {
      await runToastAction({
        action: work,
        onSuccess: async () => router.refresh(),
        pushToast,
        tx,
        fallbackError: { zh: "操作失败，请稍后重试。", en: "Operation failed. Please try again." },
      });
    });
  }

  function requestCliOperation(item: CliCatalogEntry, operation: "install" | "update" | "uninstall", confirmed = false): void {
    runAction(() => requestRuntimeAppOperationAction({
      runtimeId,
      source: item.source,
      name: item.name,
      operation,
      confirmHighRisk: confirmed,
    }));
    setCliRiskConfirmation(null);
    setCliRiskConfirmed(false);
  }

  function openMcpConfiguration(item: McpCatalogEntry): void {
    setSelectedMcpId(item.id);
    setEndpoint(item.endpointTemplate ?? "");
    setNonSecretParams(Object.fromEntries(item.configurationFields.map((field) => [field.name, ""])));
    setSecrets(Object.fromEntries(item.secretFields.map((field) => [field, ""])));
    setApprovedTools(new Set(item.defaultApprovedTools));
    setConfirmHighRisk(false);
  }

  function openCatalog(type: "cli" | "mcp"): void {
    setActiveTab(type);
    setCapabilityView("catalog");
    setQuery("");
    if (type === "cli") setSelectedMcpId(null);
  }

  function toggleTool(toolName: string): void {
    setApprovedTools((current) => {
      const next = new Set(current);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  }

  function submitMcpConnection(): void {
    if (!selectedMcp || !requiredRuntimeAppReady || !mcpFormValid) return;
    runAction(() => requestMcpConnectionAction({
      runtimeId,
      catalogItemId: selectedMcp.id,
      endpoint,
      nonSecretParams,
      secrets,
      approvedTools: Array.from(approvedTools),
      confirmHighRisk,
    }));
  }

  const requiredRuntimeApp = selectedMcp?.requiredRuntimeApp;
  const requiredRuntimeAppReady = !requiredRuntimeApp || installedApps.some((item) =>
    item.source === requiredRuntimeApp.source && item.name === requiredRuntimeApp.name && item.status === "installed" && item.enabled && item.version === requiredRuntimeApp.version,
  );
  const requiredRuntimeCatalogApp = requiredRuntimeApp
    ? data.catalog.find((item) => item.source === requiredRuntimeApp.source && item.name === requiredRuntimeApp.name)
    : undefined;
  const requiredRuntimeAppInstallability = requiredRuntimeCatalogApp && runtime
    ? projectRuntimeAppInstallability(requiredRuntimeCatalogApp.installability, runtime.cliReadiness)
    : undefined;
  const requiredRuntimeAppOperationActive = Boolean(requiredRuntimeApp && cliOperations.some((operation) =>
    operation.appSource === requiredRuntimeApp.source
    && operation.appName === requiredRuntimeApp.name
    && isActiveCapabilityOperationStatus(operation.status),
  ));
  const supportsSelectedMcpTransport = selectedMcp?.transport === "managed_stdio"
    || selectedMcp?.transport === "managed_service"
    || selectedMcp?.transport === "streamable_http";
  const selectedMcpRequiresHighRiskConfirmation = Boolean(
    selectedMcp && (selectedMcp.risk === "high" || selectedMcp.declaredTools.some((tool) => tool.risk === "high" && approvedTools.has(tool.name))),
  );
  const mcpFormValid = Boolean(selectedMcp && supportsSelectedMcpTransport && endpoint.trim())
    && Boolean(selectedMcp?.configurationFields.every((field) => !field.required || nonSecretParams[field.name]?.trim()))
    && Boolean(selectedMcp?.secretFields.every((field) => secrets[field]?.trim()))
    && (!selectedMcpRequiresHighRiskConfirmation || confirmHighRisk);

  function continueMcpSetup(): void {
    if (!requiredRuntimeAppReady && requiredRuntimeApp) {
      runAction(() => requestRuntimeAppOperationAction({
        runtimeId,
        source: requiredRuntimeApp.source,
        name: requiredRuntimeApp.name,
        operation: "install",
      }));
      return;
    }
    submitMcpConnection();
  }

  return (
    <section className="runtime-detail__section runtime-capabilities" aria-labelledby="runtime-capabilities-title">
      <div className="runtime-detail__section-heading runtime-capabilities__heading">
        <div>
          <span>{tx("能力资源", "Capabilities")}</span>
          <h2 id="runtime-capabilities-title">{tx("CLI 与 MCP", "CLI and MCP")}</h2>
        </div>
        <div className="runtime-capabilities__heading-actions">
          <p>{tx("能力安装在 Runtime，并由绑定的 AI 员工实时继承。", "Capabilities are installed on the runtime and inherited live by bound AI employees.")}</p>
          <div>
            <button className="modal-secondary-button" onClick={() => openCatalog("cli")} type="button"><AppIcon name="download" /><span>{tx("安装 CLI", "Install CLI")}</span></button>
            <button className="action-button" onClick={() => openCatalog("mcp")} type="button"><AppIcon name="plus" /><span>{tx("连接 MCP", "Connect MCP")}</span></button>
          </div>
        </div>
      </div>

      <div className="runtime-capabilities__summary" aria-label={tx("Runtime 能力概览", "Runtime capability overview")}>
        <span><strong>{installedApps.filter((item) => item.status === "installed" && item.enabled).length}</strong>{tx("个 CLI 可用", "CLI available")}</span>
        <span><strong>{mcpConnections.filter((item) => item.status === "ready").length}</strong>{tx("个 MCP 可用", "MCP available")}</span>
        <span><strong>{cliOperations.length + mcpOperations.length}</strong>{tx("条操作记录", "operation records")}</span>
      </div>

      <div className="runtime-capabilities__views" role="tablist" aria-label={tx("能力管理视图", "Capability management view")}>
        <button aria-selected={capabilityView === "current"} onClick={() => { setCapabilityView("current"); setQuery(""); setSelectedMcpId(null); }} role="tab" type="button">{tx("当前能力", "Current capabilities")}</button>
        <button aria-selected={capabilityView === "catalog"} onClick={() => setCapabilityView("catalog")} role="tab" type="button">{tx("能力目录", "Capability catalog")}</button>
        <button aria-selected={capabilityView === "history"} onClick={() => { setCapabilityView("history"); setQuery(""); setSelectedMcpId(null); }} role="tab" type="button">{tx("安装记录", "Installation history")}<span>{cliOperations.length + mcpOperations.length}</span></button>
      </div>

      {capabilityView !== "history" ? <div className="runtime-capabilities__tabs" role="tablist" aria-label={tx("能力类型", "Capability type")}>
        <button aria-selected={activeTab === "cli"} className={activeTab === "cli" ? "runtime-capabilities__tab runtime-capabilities__tab--active" : "runtime-capabilities__tab"} onClick={() => { setActiveTab("cli"); setQuery(""); setSelectedMcpId(null); }} role="tab" type="button">
          <AppIcon name="terminal" /><span><strong>CLI</strong><small>{installedApps.length}/{data.catalog.length}</small></span>
        </button>
        <button aria-selected={activeTab === "mcp"} className={activeTab === "mcp" ? "runtime-capabilities__tab runtime-capabilities__tab--active" : "runtime-capabilities__tab"} onClick={() => { setActiveTab("mcp"); setQuery(""); }} role="tab" type="button">
          <AppIcon name="containers" /><span><strong>MCP</strong><small>{mcpConnections.length}/{data.mcpCatalog.length}</small></span>
        </button>
      </div> : null}

      {capabilityView !== "history" ? <div className="runtime-capabilities__controls">
        <p>{capabilityView === "current" ? tx("仅显示此 Runtime 当前可用的能力", "Showing capabilities currently available on this runtime") : tx("从目录为此 Runtime 安装或连接能力", "Install or connect capabilities from the catalog")}</p>
        <label className="market-search runtime-capabilities__search">
          <AppIcon name="search" />
          <input aria-label={activeTab === "cli" ? tx("搜索 CLI", "Search CLI") : tx("搜索 MCP", "Search MCP")} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={tx("搜索名称、命令或说明", "Search name, command, or description")} value={query} />
        </label>
      </div> : null}

      {capabilityView === "history" ? (
        <div className="runtime-capabilities__history-view" role="tabpanel">
          <OperationHistory language={language} open title={tx("CLI 安装记录", "CLI installation history")} rows={cliOperations.map((operation) => ({ id: operation.id, name: operation.appName, operation: operation.operation, status: operation.status, stageLabel: runtimeAppOperationStageLabel(operation.status === "failed" ? operation.failedStage : operation.stage, tx), createdAt: operation.createdAt }))} tx={tx} />
          <OperationHistory language={language} open title={tx("MCP 操作记录", "MCP operation history")} rows={mcpOperations.map((operation) => ({ id: operation.id, name: mcpConnections.find((connection) => connection.id === operation.connectionId)?.catalogDisplayName ?? operation.connectionId, operation: operation.operation, status: operation.status, stageLabel: mcpOperationStageLabel(operation.status === "failed" ? operation.failedStage : operation.stage, tx), createdAt: operation.createdAt }))} tx={tx} />
        </div>
      ) : activeTab === "cli" ? (
        <div className="runtime-capabilities__body" role="tabpanel">
          <div className="runtime-capability-list">
            {visibleCli.map((item) => {
              const key = `${item.source}:${item.name}`;
              const installation = installedApps.find((installed) => installed.source === item.source && installed.name === item.name);
              const activeOperation = cliOperations.find((operation) => operation.appSource === item.source && operation.appName === item.name && isActiveCapabilityOperationStatus(operation.status));
              const installed = installation?.status === "installed" && installation.enabled;
              const installability = runtime
                ? projectRuntimeAppInstallability(item.installability, runtime.cliReadiness)
                : { status: "unsupported" as const, code: "runtime.offline" };
              const mutationBlocked = installability.status !== "installable";
              return (
                <article className="runtime-capability-row" key={key}>
                  <span className="runtime-capability-row__icon"><AppIcon name="terminal" /></span>
                  <div className="runtime-capability-row__identity">
                    <strong>{item.displayName}</strong>
                    <span>{item.entryPoint || item.name} · {item.version || tx("版本未知", "unknown version")}</span>
                    {mutationBlocked ? <span className="runtime-capability-row__reason">{runtimeAppInstallabilityReason(installability.code, tx)}</span> : null}
                  </div>
                  <span className={`status-chip status-chip--${activeOperation ? "warning" : installed ? "positive" : installation?.status === "failed" || installability.status === "unsupported" ? "danger" : installability.status === "needs_configuration" ? "warning" : "neutral"}`}>
                    {activeOperation?.status ?? (installed ? tx("已安装", "Installed") : installation?.status === "failed" ? tx("安装失败", "Failed") : runtimeAppInstallabilityStatusLabel(installability.status, tx))}
                  </span>
                  <div className="runtime-capability-row__actions">
                    {item.risk === "high" && !installed && !mutationBlocked && cliRiskConfirmation === key ? (
                      <label className="runtime-capability-row__confirm"><input checked={cliRiskConfirmed} onChange={(event) => setCliRiskConfirmed(event.currentTarget.checked)} type="checkbox" /><span>{tx("确认高风险安装", "Confirm high-risk install")}</span></label>
                    ) : null}
                    <button className={installed ? "modal-secondary-button" : "action-button"} disabled={isPending || runtimeStatus !== "online" || mutationBlocked || Boolean(activeOperation) || (!installed && item.risk === "high" && cliRiskConfirmation === key && !cliRiskConfirmed)} onClick={() => {
                      if (!installed && item.risk === "high" && cliRiskConfirmation !== key) { setCliRiskConfirmation(key); setCliRiskConfirmed(false); return; }
                      requestCliOperation(item, installed ? "update" : "install", item.risk === "high" && cliRiskConfirmed);
                    }} type="button">
                      <AppIcon name={installed ? "refresh" : "download"} /><span>{installed ? tx("更新", "Update") : item.risk === "high" && cliRiskConfirmation !== key ? tx("审核安装", "Review install") : tx("安装", "Install")}</span>
                    </button>
                    {installed ? <button className="modal-secondary-button" disabled={isPending || runtimeStatus !== "online" || Boolean(activeOperation)} onClick={() => requestCliOperation(item, "uninstall")} type="button"><AppIcon name="trash" /><span>{tx("卸载", "Uninstall")}</span></button> : null}
                  </div>
                </article>
              );
            })}
            {visibleCli.length === 0 ? <p className="runtime-capability-list__empty">{capabilityView === "current" ? tx("当前 Runtime 尚未安装 CLI。", "No CLI is installed on this runtime.") : tx("没有匹配的 CLI。", "No matching CLI found.")}</p> : null}
          </div>
        </div>
      ) : (
        <div className="runtime-capabilities__body" role="tabpanel">
          <div className="runtime-capability-list">
            {visibleMcp.map((item) => {
              const connection = mcpConnections.find((candidate) => candidate.catalogItemId === item.id);
              const supportsTransport = item.transport === "managed_stdio"
                || item.transport === "managed_service"
                || item.transport === "streamable_http";
              return (
                <article className="runtime-capability-row" key={item.id}>
                  <span className="runtime-capability-row__icon"><AppIcon name="containers" /></span>
                  <div className="runtime-capability-row__identity">
                    <strong>{item.displayName}</strong>
                    <span>{item.transport} · {item.declaredTools.length} {tx("个工具", "tools")}</span>
                  </div>
                  <span className={`status-chip status-chip--${connection?.status === "ready" ? "positive" : connection?.status === "failed" || connection?.status === "degraded" ? "danger" : connection ? "warning" : "neutral"}`}>
                    {connection?.status === "ready"
                      ? tx("已连接", "Connected")
                      : connection?.status === "failed"
                        ? tx("验证失败", "Failed")
                        : connection?.status === "degraded"
                          ? tx("连接异常", "Degraded")
                          : connection?.status === "disabled"
                            ? tx("已停用", "Disabled")
                            : connection
                              ? tx("验证中", "Verifying")
                              : tx("可连接", "Available")}
                  </span>
                  <div className="runtime-capability-row__actions">
                    {connection ? (
                      <>
                        <Link className="modal-secondary-button" href={buildWorkspacePath(workspaceSlug, `/market/mcp-connections/${connection.id}`)}>{tx("管理", "Manage")}</Link>
                        <button className="modal-secondary-button" disabled={isPending || connection.status === "disabled"} onClick={() => runAction(() => reverifyMcpConnectionAction({ connectionId: connection.id }))} type="button">{tx("重新验证", "Re-verify")}</button>
                        <button className="modal-secondary-button mcp-danger-button" disabled={isPending} onClick={() => runAction(() => removeMcpConnectionAction({ connectionId: connection.id }))} type="button">{tx("移除", "Remove")}</button>
                      </>
                    ) : (
                      <button className="action-button" disabled={isPending || runtimeStatus !== "online" || !runtime?.mcpEligible || !supportsTransport} onClick={() => openMcpConfiguration(item)} type="button"><AppIcon name="plus" /><span>{supportsTransport ? tx("配置并连接", "Configure") : tx("暂未支持", "Unsupported")}</span></button>
                    )}
                  </div>
                </article>
              );
            })}
            {visibleMcp.length === 0 ? <p className="runtime-capability-list__empty">{capabilityView === "current" ? tx("当前 Runtime 尚未连接 MCP 服务。", "No MCP service is connected to this runtime.") : tx("没有匹配的 MCP 服务。", "No matching MCP service found.")}</p> : null}
          </div>

          {selectedMcp ? (
            <form className="runtime-mcp-config" onSubmit={(event) => { event.preventDefault(); continueMcpSetup(); }}>
              <div className="runtime-mcp-config__heading"><div><span>MCP</span><h3>{selectedMcp.displayName}</h3></div><button aria-label={tx("关闭 MCP 配置", "Close MCP configuration")} className="icon-button" onClick={() => setSelectedMcpId(null)} type="button"><AppIcon name="close" /></button></div>
              <div className="runtime-mcp-config__fields">
                <label className="form-field"><span>{selectedMcp.transport === "managed_stdio" ? tx("受管 stdio 入口", "Managed stdio entrypoint") : selectedMcp.transport === "managed_service" ? tx("受管服务", "Managed service") : "Endpoint (HTTPS)"}</span><input onChange={(event) => setEndpoint(event.currentTarget.value)} readOnly={selectedMcp.transport === "managed_stdio" || selectedMcp.transport === "managed_service"} value={endpoint} /></label>
                {selectedMcp.configurationFields.map((field) => <label className="form-field" key={field.name}><span>{field.name}{field.required ? " *" : ""}</span><input maxLength={field.maxLength} onChange={(event) => setNonSecretParams((current) => ({ ...current, [field.name]: event.currentTarget.value }))} value={nonSecretParams[field.name] ?? ""} /></label>)}
                {selectedMcp.secretFields.map((field) => <label className="form-field" key={field}><span>{field} *</span><input autoComplete="off" onChange={(event) => setSecrets((current) => ({ ...current, [field]: event.currentTarget.value }))} placeholder={tx("保存后不会显示", "Hidden after save")} type="password" value={secrets[field] ?? ""} /></label>)}
              </div>
              <details className="mcp-tool-scope" open={selectedMcp.declaredTools.length <= 6}>
                <summary className="mcp-tool-scope__summary"><span className="mcp-section-label">{tx("工具范围", "Tool scope")}</span><span>{approvedTools.size}/{selectedMcp.declaredTools.length}</span></summary>
                <div className="mcp-tool-scope__list">{selectedMcp.declaredTools.map((tool) => <label className="mcp-tool-row" key={tool.name}><input checked={approvedTools.has(tool.name)} onChange={() => toggleTool(tool.name)} type="checkbox" /><span><strong>{tool.name}</strong><small>{tool.description}</small></span><span className={`status-chip status-chip--${tool.risk === "high" ? "danger" : tool.risk === "medium" ? "warning" : "positive"}`}>{tool.risk}</span></label>)}</div>
              </details>
              {selectedMcpRequiresHighRiskConfirmation ? <label className="market-confirm-risk"><input checked={confirmHighRisk} onChange={(event) => setConfirmHighRisk(event.currentTarget.checked)} type="checkbox" /><span>{tx("确认此 Runtime 将访问声明的数据域", "Confirm access to the declared data domains")}</span></label> : null}
              {selectedMcp.transport === "managed_stdio" ? <ManagedMcpSetupProgress configurationReady={Boolean(endpoint.trim()) && selectedMcp.configurationFields.every((field) => !field.required || Boolean(nonSecretParams[field.name]?.trim())) && selectedMcp.secretFields.every((field) => Boolean(secrets[field]?.trim()))} dependencyReady={requiredRuntimeAppReady} dependencyRequired={Boolean(requiredRuntimeApp)} permissionsReady={!selectedMcpRequiresHighRiskConfirmation || confirmHighRisk} runtimeReady={Boolean(runtime)} tx={tx} /> : null}
              <div className="market-action-row">
                <button className="primary-button" disabled={isPending || runtimeStatus !== "online" || !runtime?.mcpEligible || requiredRuntimeAppOperationActive || (requiredRuntimeAppReady ? !mcpFormValid : requiredRuntimeAppInstallability?.status !== "installable")} type="submit"><AppIcon name={requiredRuntimeAppReady ? "plus" : "download"} /><span>{requiredRuntimeAppOperationActive ? tx("正在安装依赖 CLI", "Installing dependency CLI") : requiredRuntimeAppReady ? tx("继续：验证并连接", "Continue: verify and connect") : tx("继续：安装依赖 CLI", "Continue: install dependency CLI")}</span></button>
              </div>
              {requiredRuntimeApp && !requiredRuntimeAppReady && requiredRuntimeAppInstallability?.status !== "installable" ? <p className="panel-note panel-note--danger">{runtimeAppInstallabilityReason(requiredRuntimeAppInstallability?.code ?? "runtime_app.catalog_item_missing", tx)}</p> : null}
            </form>
          ) : null}
        </div>
      )}
      {runtimeStatus !== "online" ? <p className="runtime-capabilities__notice" role="status">{tx(`${runtimeName} 当前离线，恢复在线后才可安装或变更能力。`, `${runtimeName} is offline. Bring it online before changing capabilities.`)}</p> : null}
      {runtimeStatus === "online" && !runtime?.mcpEligible ? <p className="runtime-capabilities__notice" role="status">{tx("当前 Provider 尚未启用 MCP 网关，CLI 安装不受影响。", "The MCP gateway is not enabled for this provider; CLI installation remains available.")}</p> : null}
    </section>
  );
}

function OperationHistory({
  language,
  open = false,
  rows,
  title,
  tx,
}: {
  language: "zh" | "en";
  open?: boolean;
  rows: Array<{ id: string; name: string; operation: string; status: string; stageLabel?: string; createdAt: string }>;
  title: string;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <details className="runtime-capability-history" open={open}>
      <summary><span>{title}</span><strong>{rows.length}</strong></summary>
      {rows.length > 0 ? <ul>{rows.map((row) => <li key={row.id}><span><strong>{row.name}</strong><small>{operationLabel(row.operation, tx)} · <time dateTime={row.createdAt}>{formatTimestamp(row.createdAt, language)}</time></small></span><span className={`status-chip status-chip--${row.status === "succeeded" || row.status === "installed" ? "positive" : row.status === "failed" ? "danger" : isActiveCapabilityOperationStatus(row.status) ? "warning" : "neutral"}`}>{row.stageLabel ?? operationStatusLabel(row.status, tx)}</span></li>)}</ul> : <p>{tx("暂无记录", "No records")}</p>}
    </details>
  );
}

function operationLabel(operation: string, tx: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    install: ["安装", "Install"],
    update: ["更新", "Update"],
    uninstall: ["卸载", "Uninstall"],
    verify: ["验证", "Verify"],
    enable: ["启用", "Enable"],
    disable: ["停用", "Disable"],
    remove: ["移除", "Remove"],
  };
  const label = labels[operation];
  return label ? tx(label[0], label[1]) : operation;
}

function operationStatusLabel(status: string, tx: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    pending: ["等待中", "Pending"],
    claimed: ["已领取", "Claimed"],
    running: ["进行中", "Running"],
    succeeded: ["已成功", "Succeeded"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    installed: ["已安装", "Installed"],
  };
  const label = labels[status];
  return label ? tx(label[0], label[1]) : status;
}

function formatTimestamp(value: string, language: "zh" | "en"): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
