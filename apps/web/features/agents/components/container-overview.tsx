import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { MetaCard } from "@/shared/ui/meta-card";
import { RuntimeGrantsPanel } from "@/features/agents/components/runtime-grants-panel";
import { AppIcon } from "@/shared/ui/app-icon";
import type { AgentsPageData, ContainerRecord } from "@/features/dashboard/data";
import {
  toneForStatus,
  translateContainerDescription,
  translateManagementStatus,
} from "@/features/agents/lib/translate";

interface ContainerOverviewProps {
  readonly container: ContainerRecord | null;
  readonly selection: string | null;
  readonly containerCount: number;
  readonly pending?: boolean;
  readonly updating?: boolean;
  readonly workspaceMembers?: AgentsPageData["workspaceMembers"];
  readonly onGrantRuntime?: (runtimeId: string, userId: string) => void;
  readonly onRevokeRuntime?: (runtimeId: string, userId: string) => void;
  readonly onUpdateRuntimeDisplayName?: (runtimeId: string, displayName: string) => void;
  readonly onUpdateRuntime?: (container: ContainerRecord) => void;
  readonly onDeleteRuntime?: (runtimeId: string, runtimeName: string) => void;
}

export function ContainerOverview({
  container,
  selection,
  containerCount,
  pending = false,
  updating = false,
  workspaceMembers = [],
  onGrantRuntime,
  onRevokeRuntime,
  onUpdateRuntimeDisplayName,
  onUpdateRuntime,
  onDeleteRuntime,
}: ContainerOverviewProps) {
  const { tx } = useLanguage();
  const [displayName, setDisplayName] = useState(container?.displayName ?? "");
  const [isEditingDisplayName, setIsEditingDisplayName] = useState(false);

  useEffect(() => {
    setDisplayName(container?.displayName ?? "");
    setIsEditingDisplayName(false);
  }, [container?.displayName, container?.runtimeId]);

  if (!container && !selection) {
    return (
      <div className="subsection">
        <div className="panel-header">
          <div>
            <h3>{tx("请选择执行引擎", "Select an execution engine")}</h3>
          </div>
        </div>
        <div className="detail-meta">
          <MetaCard label={tx("执行引擎数", "Execution Engines")} value={String(containerCount)} />
          <MetaCard label={tx("说明", "Note")} value={tx("执行引擎视图不展示 agent 内容", "Execution engine view does not include agent details")} />
        </div>
      </div>
    );
  }

  if (!container) {
    return null;
  }

  const heading = container.name;
  const canEditDisplayName = Boolean(container.canManageGrants && onUpdateRuntimeDisplayName);

  return (
    <div className="subsection">
      <div className="panel-header">
        <div className="runtime-overview-heading">
          <h3>{heading}</h3>
          <div className="runtime-overview-heading__remark">
            <span>
              {container.displayName
                ? tx(`备注名：${container.displayName}`, `Remark: ${container.displayName}`)
                : tx("未设置备注名", "No remark name")}
            </span>
            {canEditDisplayName ? (
              <button
                aria-label={tx("编辑备注名", "Edit remark name")}
                className="runtime-display-name-edit-button"
                disabled={pending || updating}
                onClick={() => setIsEditingDisplayName(true)}
                type="button"
              >
                <AppIcon name="edit" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="runtime-overview-actions">
          <span className={`status-chip status-chip--${toneForStatus(container.status)}`}>{translateManagementStatus(container.statusLabel, tx)}</span>
          {onUpdateRuntime ? (
            <button
              aria-busy={updating}
              className="primary-button runtime-overview-update"
              disabled={pending || updating}
              onClick={() => onUpdateRuntime(container)}
              type="button"
            >
              <AppIcon name="refresh" />
              <span>{updating ? tx("生成中...", "Generating...") : tx("更新执行引擎", "Update execution engine")}</span>
            </button>
          ) : null}
          {onDeleteRuntime ? (
            <button
              aria-label={tx(`删除执行引擎 ${container.name}`, `Delete execution engine ${container.name}`)}
              className="action-button action-button--danger runtime-overview-delete"
              disabled={pending || updating}
              onClick={() => onDeleteRuntime(container.runtimeId, container.name)}
              type="button"
            >
              <AppIcon name="trash" />
              <span>{tx("删除", "Delete")}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="detail-copy">
        <p>{translateContainerDescription(container.description, tx)}</p>
      </div>

      {canEditDisplayName && isEditingDisplayName ? (
        <form
          className="runtime-display-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            onUpdateRuntimeDisplayName?.(container.runtimeId, displayName);
            setIsEditingDisplayName(false);
          }}
        >
          <label className="form-field">
            <span>{tx("备注名", "Remark name")}</span>
            <input
              disabled={pending}
              maxLength={80}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              placeholder={tx("例如：办公室 Mac mini / 云端测试机", "For example: Office Mac mini / Cloud test box")}
              value={displayName}
            />
          </label>
          <button
            className="primary-button"
            disabled={pending || displayName.trim() === (container.displayName ?? "")}
            type="submit"
          >
            {tx("保存备注", "Save remark")}
          </button>
          <button
            className="modal-secondary-button"
            disabled={pending}
            onClick={() => {
              setDisplayName(container.displayName ?? "");
              setIsEditingDisplayName(false);
            }}
            type="button"
          >
            {tx("取消", "Cancel")}
          </button>
        </form>
      ) : null}

      <section className="runtime-overview-identity" aria-label={tx("执行引擎身份", "Execution engine identity")}>
        <div>
          <span>{tx("执行提供方", "Execution provider")}</span>
          <strong>{formatDaemonProviderLabel(container.provider)}</strong>
        </div>
        <div>
          <span>{tx("运行服务器", "Runtime server")}</span>
          <strong>{container.deviceName}</strong>
          <small>{tx(`服务器标识：${container.daemonKey}`, `Server ID: ${container.daemonKey}`)}</small>
        </div>
      </section>

      <div className="detail-meta detail-meta--runtime-stats">
        <MetaCard label={tx("执行中工作区", "Running work areas")} value={String(container.queueCounts.running)} />
        <MetaCard label={tx("排队中", "Queued")} value={String(container.queueCounts.queued)} />
        <MetaCard label={tx("失败 / 完成", "Failed / Completed")} value={`${container.queueCounts.failed} / ${container.queueCounts.completed}`} />
      </div>

      <div className="meta-strip">
        <span>{tx(`版本：${container.version ?? "未返回"}`, `Version: ${container.version ?? "Unavailable"}`)}</span>
        <span>{tx(`最近心跳：${container.lastHeartbeatAt ?? "未收到"}`, `Last heartbeat: ${container.lastHeartbeatAt ?? "Not received"}`)}</span>
      </div>

      <div className="detail-copy">
        <p>{tx("这里只显示执行引擎状态与运行统计。", "This view shows engine status and runtime stats only.")}</p>
      </div>

      <section className="runtime-apps-panel">
        <div className="runtime-execution-panel__header">
          <h4>{tx("已安装应用", "Installed apps")}</h4>
          <span className="panel-note">{container.installedApps.length}</span>
        </div>
        {container.cliHubReadiness ? (
          <div className="runtime-app-readiness">
            <ReadinessPill label="python" available={container.cliHubReadiness.python.available} />
            <ReadinessPill label="pip" available={container.cliHubReadiness.pip.available} />
            <ReadinessPill label="cli-hub" available={container.cliHubReadiness.cliHub.available} />
            <ReadinessPill label="npm" available={container.cliHubReadiness.npm.available} />
            <ReadinessPill label="uv" available={container.cliHubReadiness.uv.available} />
          </div>
        ) : null}
        {container.installedApps.length > 0 ? (
          <div className="runtime-app-list">
            {container.installedApps.map((app) => (
              <article className="runtime-app-item" key={`${app.source}:${app.name}`}>
                <div>
                  <strong>{app.displayName}</strong>
                  <span>{app.entryPoint || app.name}</span>
                </div>
                <span className={`status-chip status-chip--${app.status === "installed" ? "positive" : app.status === "failed" ? "danger" : "neutral"}`}>
                  {translateRuntimeAppStatus(app.enabled ? app.status : "disabled", tx)}
                </span>
                {app.lastError ? <p>{app.lastError}</p> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="panel-note">{tx("还没有安装运行时应用。", "No runtime apps installed yet.")}</p>
        )}
        {container.recentAppOperations.length > 0 ? (
          <div className="runtime-app-operation-list">
            {container.recentAppOperations.map((operation) => (
              <div className="runtime-app-operation" key={operation.id}>
                <span>{translateRuntimeAppOperation(operation.operation, tx)}</span>
                <strong>{operation.appName}</strong>
                <span>{translateRuntimeAppStatus(operation.status, tx)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {container.recentExecutions.length > 0 ? (
        <section className="runtime-execution-panel">
          <div className="runtime-execution-panel__header">
            <h4>{tx("最近执行", "Recent Executions")}</h4>
            <span className="panel-note">{container.recentExecutions.length}</span>
          </div>
          <div className="runtime-execution-list">
            {container.recentExecutions.map((execution) => {
              const latest = execution.timeline.at(-1);
              return (
                <article className="runtime-execution-item" key={execution.queueId}>
                  <div className="runtime-execution-item__title-row">
                    <strong>{execution.title}</strong>
                    <span className={`status-chip status-chip--${execution.errorText ? "danger" : "neutral"}`}>
                      {translateQueueStatus(execution.queueStatus, tx)}
                    </span>
                  </div>
                  <div className="runtime-execution-item__meta">
                    <span>{execution.assignee}</span>
                    {execution.channel ? <span>#{execution.channel}</span> : null}
                    <span>{tx(`${execution.messageCount} 条消息`, `${execution.messageCount} messages`)}</span>
                    {execution.router ? <span>{tx(`路由会话：${execution.router.routerSessionId}`, `Router session: ${execution.router.routerSessionId}`)}</span> : null}
                    {execution.router ? <span>{tx(`${execution.router.attempts.length} 次尝试`, `${execution.router.attempts.length} attempts`)}</span> : null}
                  </div>
                  {latest ? (
                    <div className={`runtime-execution-event runtime-execution-event--${latest.severity}`}>
                      <AppIcon name={latest.severity === "error" ? "alertCircle" : latest.status === "succeeded" ? "checkCircle" : "info"} />
                      <div>
                        <span>{translateExecutionEventTitle(latest, tx)}</span>
                        {latest.summary ? <p>{latest.summary}</p> : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {container.canManageGrants && onGrantRuntime && onRevokeRuntime ? (
        <RuntimeGrantsPanel
          container={container}
          members={workspaceMembers}
          pending={pending}
          onGrantRuntime={(userId) => onGrantRuntime(container.runtimeId, userId)}
          onRevokeRuntime={(userId) => onRevokeRuntime(container.runtimeId, userId)}
        />
      ) : null}
    </div>
  );
}

function ReadinessPill({ label, available }: { label: string; available: boolean }) {
  return (
    <span className={`runtime-app-readiness__pill runtime-app-readiness__pill--${available ? "ok" : "missing"}`}>
      {label}
    </span>
  );
}

function translateQueueStatus(status: string, tx: (zh: string, en: string) => string): string {
  if (status === "queued") return tx("排队中", "Queued");
  if (status === "claimed") return tx("已接手", "Claimed");
  if (status === "running") return tx("运行中", "Running");
  if (status === "completed") return tx("已完成", "Completed");
  if (status === "failed") return tx("失败", "Failed");
  if (status === "cancelled") return tx("已取消", "Cancelled");
  return status;
}

function translateRuntimeAppStatus(status: string, tx: (zh: string, en: string) => string): string {
  if (status === "installed") return tx("已安装", "Installed");
  if (status === "installing") return tx("安装中", "Installing");
  if (status === "failed") return tx("失败", "Failed");
  if (status === "disabled") return tx("已停用", "Disabled");
  return status;
}

function translateRuntimeAppOperation(operation: string, tx: (zh: string, en: string) => string): string {
  if (operation === "install") return tx("安装", "Install");
  if (operation === "update") return tx("更新", "Update");
  if (operation === "uninstall") return tx("卸载", "Uninstall");
  if (operation === "refresh") return tx("刷新", "Refresh");
  return operation;
}

function translateExecutionEventTitle(
  event: ContainerRecord["recentExecutions"][number]["timeline"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (event.type === "queued") return tx("已进入队列", "Queued");
  if (event.type === "assigned") return tx("执行引擎已接手", "Claimed");
  if (event.type === "workspace_prepared") return tx("执行已开始", "Started");
  if (event.type === "context_loaded") return tx("上下文已加载", "Context loaded");
  if (event.type === "tool_started") return tx("工具开始", "Tool started");
  if (event.type === "tool_finished") return tx("工具完成", "Tool finished");
  if (event.type === "artifact_detected") return tx("检测到产物", "Artifact detected");
  if (event.type === "artifact_collected") return tx("产物已回收", "Artifact collected");
  if (event.type === "approval_requested") return tx("等待审批", "Approval requested");
  if (event.type === "blocked") return tx("需要处理", "Blocked");
  if (event.type === "failed") return tx("失败", "Failed");
  if (event.type === "completed") return tx("完成", "Completed");
  return event.title;
}
