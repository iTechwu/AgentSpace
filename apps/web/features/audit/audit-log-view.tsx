"use client";

import Link from "next/link";
import type { AuditLogRecord } from "@dofe-agent/db";
import { useLanguage } from "@/features/i18n/language-provider";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import type { AuditLogFilters } from "@/features/audit/audit-log-filters";

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
              <tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString(language === "zh" ? "zh-CN" : "en")}</td><td><code>{log.code ?? log.source}</code></td><td>{log.title}</td><td className="audit-table__muted">{log.note}</td><td><code className="audit-table__context">{formatData(log.dataJson)}</code></td></tr>)}</tbody>
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

function toLocalInput(value: string | undefined): string | undefined { return value ? value.slice(0, 16) : undefined; }
function formatData(value: string): string { try { return JSON.stringify(JSON.parse(value)); } catch { return value; } }
