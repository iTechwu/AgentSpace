"use client";

import Link from "next/link";
import type { AuditLogRecord } from "@dofe-agent/db";
import { useLanguage, type LanguageCode } from "@/features/i18n/language-provider";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import type { AuditLogFilters } from "@/features/audit/audit-log-filters";

type LocalizedEventLabel = Record<LanguageCode, string>;

const AUDIT_EVENT_LABELS: Record<string, LocalizedEventLabel> = {
  "auth.sso_login_succeeded": { zh: "用户登录成功", en: "User signed in" },
  "auth.sso_platform_admin_login_succeeded": { zh: "平台管理员登录成功", en: "Platform administrator signed in" },
  "model.resolution_fallback": { zh: "模型不可用，已自动切换", en: "Model unavailable; switched automatically" },
  "runtime.capacity_reused": { zh: "已复用可用执行引擎", en: "Available runtime reused" },
  "runtime.created": { zh: "执行引擎已创建", en: "Runtime created" },
  "runtime.default_model.changed": { zh: "默认模型已更改", en: "Default model changed" },
  "runtime.deleted": { zh: "执行引擎已删除", en: "Runtime deleted" },
  "runtime.delete_scheduled": { zh: "执行引擎已安排删除", en: "Runtime deletion scheduled" },
  "runtime.model_allowlist.expanded": { zh: "已开放所需模型", en: "Required model enabled" },
  "runtime.provision_cancelled": { zh: "已取消创建执行引擎", en: "Runtime provisioning cancelled" },
  "runtime.provision_requested": { zh: "已申请创建执行引擎", en: "Runtime provisioning requested" },
  "runtime.provision_retry": { zh: "已重试创建执行引擎", en: "Runtime provisioning retried" },
  "runtime.stopped": { zh: "执行引擎已停止", en: "Runtime stopped" },
  "runtime_credential.created": { zh: "执行引擎凭据已签发", en: "Runtime credential issued" },
  "runtime_credential.recovered": { zh: "执行引擎凭据已恢复", en: "Runtime credential recovered" },
  "runtime_credential.recovery_failed": { zh: "执行引擎凭据恢复失败", en: "Runtime credential recovery failed" },
  "runtime_credential.recovery_retry_scheduled": { zh: "执行引擎凭据将自动重试恢复", en: "Runtime credential recovery retry scheduled" },
  "runtime_credential.recovery_started": { zh: "开始恢复执行引擎凭据", en: "Runtime credential recovery started" },
  "runtime_credential.reissued": { zh: "执行引擎凭据已重新签发", en: "Runtime credential reissued" },
  "runtime_credential.rotated": { zh: "执行引擎凭据已轮换", en: "Runtime credential rotated" },
  "runtime_credential.status_checked": { zh: "已检查执行引擎凭据状态", en: "Runtime credential status checked" },
  "session.model_override_cleared": { zh: "已恢复会话默认模型", en: "Session default model restored" },
  "session.model_overridden": { zh: "已指定会话模型", en: "Session model selected" },
  "usage.reconciliation_completed": { zh: "用量对账已完成", en: "Usage reconciliation completed" },
  "usage.reconciliation_started": { zh: "用量对账已开始", en: "Usage reconciliation started" },
  platform_admin: { zh: "平台管理操作", en: "Platform administration activity" },
  runtime_credential: { zh: "执行引擎凭据变更", en: "Runtime credential activity" },
  runtime_lifecycle: { zh: "执行引擎状态变更", en: "Runtime lifecycle activity" },
  runtime_model: { zh: "模型配置变更", en: "Model configuration activity" },
  workspace_snapshot_ledger: { zh: "工作区操作记录", en: "Workspace activity" },
};

export function AuditLogView({
  logs,
  filters,
  clearHref,
  title,
  description,
  eyebrow,
}: {
  logs: AuditLogRecord[];
  filters: AuditLogFilters;
  clearHref: string;
  title?: string;
  description?: string;
  eyebrow?: string;
}) {
  const { tx, language } = useLanguage();
  const fields: Array<[keyof AuditLogFilters, string]> = [
    ["code", tx("事件类型", "Event type")], ["actorId", tx("操作人", "Actor")], ["employeeId", tx("AI 员工", "AI employee")],
    ["runtimeId", tx("执行引擎", "Runtime")], ["sessionId", tx("会话", "Session")], ["taskId", tx("任务", "Task")], ["modelId", tx("模型", "Model")],
  ];
  return (
    <section className="page-shell audit-page">
      <WorkbenchPageHeader
        description={description ?? tx("集中检索工作区操作、执行引擎运行与治理事件。", "Search workspace operations, runtime execution, and governance events in one place.")}
        eyebrow={eyebrow ?? tx("治理", "Governance")}
        meta={<span>{tx(`${logs.length} 条记录`, `${logs.length} records`)}</span>}
        title={title ?? tx("审计日志", "Audit log")}
      />
      <div className="audit-page__content">
        <section className="audit-panel" aria-labelledby="audit-filter-title">
          <div className="audit-panel__header">
            <div>
              <span>{tx("查询", "Query")}</span>
              <h2 id="audit-filter-title">{tx("筛选条件", "Filters")}</h2>
            </div>
          </div>
          <form method="get" className="audit-filters">
            {fields.map(([name, label]) => <label key={name} className="audit-field"><span>{label}</span><input name={name} defaultValue={filters[name]} /></label>)}
            <label className="audit-field"><span>{tx("开始时间", "From")}</span><input type="datetime-local" name="createdFrom" defaultValue={toLocalInput(filters.createdFrom)} /></label>
            <label className="audit-field"><span>{tx("结束时间", "To")}</span><input type="datetime-local" name="createdTo" defaultValue={toLocalInput(filters.createdTo)} /></label>
            <div className="audit-filters__actions">
              <Link href={clearHref} className="action-button">{tx("清除", "Clear")}</Link>
              <button type="submit" className="primary-button">{tx("应用筛选", "Apply filters")}</button>
            </div>
          </form>
        </section>

        <section className="audit-panel audit-panel--results" aria-labelledby="audit-results-title">
          <div className="audit-panel__header">
            <div>
              <span>{tx("记录", "Records")}</span>
              <h2 id="audit-results-title">{tx("事件明细", "Event details")}</h2>
            </div>
          </div>
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead><tr><th>{tx("时间", "Time")}</th><th>{tx("事件", "Event")}</th><th>{tx("标题", "Title")}</th><th>{tx("备注", "Note")}</th><th>{tx("上下文", "Context")}</th></tr></thead>
              <tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString(language === "zh" ? "zh-CN" : "en")}</td><td>{getAuditEventLabel(log, language)}</td><td>{log.title}</td><td className="audit-table__muted">{log.note}</td><td><code className="audit-table__context">{formatData(log.dataJson)}</code></td></tr>)}</tbody>
            </table>
            {logs.length === 0 ? (
              <div className="audit-empty">
                <strong>{tx("没有符合条件的审计事件", "No matching audit events")}</strong>
                <p>{tx("调整筛选条件后重新查询。", "Adjust the filters and run the query again.")}</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}

export function getAuditEventLabel(
  log: Pick<AuditLogRecord, "code" | "source" | "title">,
  language: LanguageCode,
): string {
  const label = AUDIT_EVENT_LABELS[log.code ?? log.source];
  return label?.[language] ?? (log.title.trim() || (language === "zh" ? "未命名事件" : "Unnamed event"));
}

function toLocalInput(value: string | undefined): string | undefined { return value ? value.slice(0, 16) : undefined; }
function formatData(value: string): string { try { return JSON.stringify(JSON.parse(value)); } catch { return value; } }
