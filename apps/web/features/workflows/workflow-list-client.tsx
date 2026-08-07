"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { EmptyState } from "@/shared/ui/empty-state";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import { runWorkflowAction } from "./workflow-actions";
import type { WorkflowCenterPageData, WorkflowListItem } from "./workflow-types";

type WorkflowCenterTab = "plans" | "runs" | "templates";
type WorkflowStatusFilter = "all" | WorkflowListItem["status"];

const TABS: Array<{ id: WorkflowCenterTab; zh: string; en: string }> = [
  { id: "plans", zh: "计划", en: "Plans" },
  { id: "runs", zh: "运行", en: "Runs" },
  { id: "templates", zh: "模板", en: "Templates" },
];

export function WorkflowListClient({
  data,
  workspaceSlug,
}: {
  data: WorkflowCenterPageData;
  workspaceSlug: string;
}) {
  const { tx } = useLanguage();
  const [tab, setTab] = useState<WorkflowCenterTab>("plans");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WorkflowStatusFilter>("all");
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return data.workflows.filter((workflow) =>
      (status === "all" || workflow.status === status) &&
      (!normalizedQuery || workflow.name.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [data.workflows, query, status]);

  return (
    <section className="page-shell workflow-center">
      <WorkbenchPageHeader
        actions={(
          <Link className="knowledge-btn knowledge-btn--primary" href={`/w/${workspaceSlug}/automations/new?entry=automations`}>
            {tx("新建编排", "New workflow")}
          </Link>
        )}
        description={tx(
          `${data.totals.all} 个计划，${data.totals.published} 个已发布`,
          `${data.totals.all} plans, ${data.totals.published} published`,
        )}
        title={tx("编排中心", "Orchestration")}
      />

      <div aria-label={tx("编排中心视图", "Orchestration views")} className="workflow-center__tabs" role="tablist">
        {TABS.map((item) => (
          <button
            aria-controls={`workflow-panel-${item.id}`}
            aria-selected={tab === item.id}
            className={tab === item.id ? "workflow-center__tab workflow-center__tab--active" : "workflow-center__tab"}
            id={`workflow-tab-${item.id}`}
            key={item.id}
            onClick={() => setTab(item.id)}
            role="tab"
            type="button"
          >
            {tx(item.zh, item.en)}
          </button>
        ))}
      </div>

      {tab === "plans" ? (
        <div aria-labelledby="workflow-tab-plans" id="workflow-panel-plans" role="tabpanel">
          <div className="workflow-center__toolbar">
            <label className="workflow-center__search">
              <span>{tx("搜索", "Search")}</span>
              <input onChange={(event) => setQuery(event.target.value)} placeholder={tx("编排名称", "Workflow name")} type="search" value={query} />
            </label>
            <label className="workflow-center__filter">
              <span>{tx("状态", "Status")}</span>
              <select onChange={(event) => setStatus(event.target.value as WorkflowStatusFilter)} value={status}>
                <option value="all">{tx("全部", "All")}</option>
                <option value="draft">{tx("草稿", "Draft")}</option>
                <option value="published">{tx("已发布", "Published")}</option>
                <option value="paused">{tx("已暂停", "Paused")}</option>
                <option value="archived">{tx("已归档", "Archived")}</option>
              </select>
            </label>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              actionHref={`/w/${workspaceSlug}/automations/new?entry=automations`}
              actionLabel={tx("新建编排", "New workflow")}
              body={query || status !== "all" ? tx("调整筛选条件后重试。", "Adjust the filters and try again.") : tx("当前工作区还没有编排。", "This workspace has no workflows yet.")}
              title={tx("暂无计划", "No plans")}
            />
          ) : (
            <div aria-label={tx("工作流计划", "Workflow plans")} className="workflow-center__list" role="list">
              {filtered.map((workflow) => (
                <WorkflowPlanRow key={workflow.id} workflow={workflow} workspaceSlug={workspaceSlug} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === "runs" ? (
        <div aria-labelledby="workflow-tab-runs" id="workflow-panel-runs" role="tabpanel">
          {data.workflows.some((workflow) => workflow.latestRun) ? (
            <div aria-label={tx("最近运行", "Recent runs")} className="workflow-center__list" role="list">
              {data.workflows.flatMap((workflow) => workflow.latestRun ? [(
                <div key={workflow.latestRun.id} role="listitem">
                  <Link className="workflow-center__row" href={`/w/${workspaceSlug}/automations/runs/${workflow.latestRun.id}`}>
                    <strong>{workflow.name}</strong>
                    <span>{runStatusLabel(workflow.latestRun.status, tx)}</span>
                    <span>{workflow.latestRun.finishedAt ? formatCompactTimestamp(workflow.latestRun.finishedAt) : tx("进行中", "In progress")}</span>
                  </Link>
                </div>
              )] : [])}
            </div>
          ) : (
            <EmptyState body={tx("当前工作区还没有运行记录。", "This workspace has no run history yet.")} title={tx("暂无运行", "No runs")} />
          )}
        </div>
      ) : null}

      {tab === "templates" ? (
        <div aria-labelledby="workflow-tab-templates" id="workflow-panel-templates" role="tabpanel">
          <EmptyState body={tx("工作区模板将在这里显示。", "Workspace templates will appear here.")} title={tx("暂无模板", "No templates")} />
        </div>
      ) : null}
    </section>
  );
}

function WorkflowPlanRow({ workflow, workspaceSlug }: { workflow: WorkflowListItem; workspaceSlug: string }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const href = workflow.sourceKind === "legacy"
    ? `/w/${workspaceSlug}/automations/new?entry=automations&legacySourceId=${encodeURIComponent(workflow.legacySourceId ?? "")}`
    : `/w/${workspaceSlug}/automations/${workflow.id}`;
  // 手动运行仅对「已发布且触发器为 manual」的工作流开放（与 materialization 的
  // assertManualWorkflowTriggerAvailable 服务端约束一致）。列表投影用 triggerLabelCode。
  const canRunManually = workflow.status === "published" && workflow.triggerLabelCode === "manual";
  const topology = [
    tx(`${workflow.topology.employeeNodeCount} 位员工`, `${workflow.topology.employeeNodeCount} employees`),
    ...(workflow.topology.parallelGroupCount > 0 ? [tx(`${workflow.topology.parallelGroupCount} 组并行`, `${workflow.topology.parallelGroupCount} parallel groups`)] : []),
    ...(workflow.topology.hasApproval ? [tx("含审批", "Approval")] : []),
  ].join(" · ");
  async function runNow(): Promise<void> {
    if (!canRunManually || running) return;
    if (!window.confirm("确认立即运行该工作流？")) return;
    setRunning(true);
    try {
      const result = await runWorkflowAction({
        workflowId: workflow.id,
        idempotencyKey: `list-${workflow.id}-${Date.now()}`,
        input: {},
      });
      if (result.ok) {
        router.push(`/w/${encodeURIComponent(workspaceSlug)}/automations/runs/${result.data.runId}`);
      }
    } finally {
      setRunning(false);
    }
  }
  return (
    <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Link className="workflow-center__row" href={href} style={{ flex: 1, minWidth: 0 }}>
        <span className="workflow-center__identity">
          <strong title={workflow.name}>{workflow.name}</strong>
          <small>
            {workflow.migrationStatus === "needs_migration" ? `${tx("需迁移", "Migration needed")} · ` : ""}
            {triggerLabel(workflow.triggerLabelCode, tx)} · {topology}
            {workflow.lastTriggerOutcome ? ` · ${triggerOutcomeLabel(workflow.lastTriggerOutcome.code, tx)}` : ""}
          </small>
        </span>
        <span>{workflow.nextFireAt ? formatCompactTimestamp(workflow.nextFireAt) : tx("按需运行", "On demand")}</span>
        <span>{workflow.latestRun ? runStatusLabel(workflow.latestRun.status, tx) : tx("尚未运行", "Never run")}</span>
        <span>{workflow.ownerLabel}</span>
        <span className={`workflow-center__status workflow-center__status--${workflow.status}`}>{definitionStatusLabel(workflow.status, tx)}</span>
      </Link>
      <div style={{ width: 96, flexShrink: 0, display: "flex", justifyContent: "flex-end" }}>
        {canRunManually ? (
          <button className="knowledge-btn" disabled={running} onClick={() => void runNow()} type="button">{running ? "启动中" : "立即运行"}</button>
        ) : null}
      </div>
    </div>
  );
}

function definitionStatusLabel(status: WorkflowListItem["status"], tx: (zh: string, en: string) => string): string {
  const labels = {
    draft: tx("草稿", "Draft"),
    published: tx("已发布", "Published"),
    paused: tx("已暂停", "Paused"),
    archived: tx("已归档", "Archived"),
  };
  return labels[status];
}

function runStatusLabel(status: NonNullable<WorkflowListItem["latestRun"]>["status"], tx: (zh: string, en: string) => string): string {
  const labels: Record<string, string> = {
    created: tx("待启动", "Created"), queued: tx("排队中", "Queued"), running: tx("运行中", "Running"),
    waiting_approval: tx("等待审批", "Waiting approval"), paused: tx("已暂停", "Paused"), succeeded: tx("成功", "Succeeded"),
    partially_succeeded: tx("部分成功", "Partially succeeded"), failed: tx("失败", "Failed"), cancelled: tx("已取消", "Cancelled"),
  };
  return labels[status] ?? tx("未知", "Unknown");
}

function triggerLabel(code: WorkflowListItem["triggerLabelCode"], tx: (zh: string, en: string) => string): string {
  if (code === "schedule") return tx("定时", "Schedule");
  if (code === "event") return tx("事件", "Event");
  if (code === "none") return tx("未配置", "Not configured");
  return tx("手动", "Manual");
}

function triggerOutcomeLabel(code: NonNullable<WorkflowListItem["lastTriggerOutcome"]>["code"], tx: (zh: string, en: string) => string): string {
  const labels = {
    "workflow.trigger.misfire_skipped": tx("已跳过错过的执行", "Missed run skipped"),
    "workflow.trigger.misfire_fire_once": tx("已补执行最近一次", "Latest missed run recovered"),
    "workflow.trigger.invalid": tx("触发配置异常", "Invalid trigger configuration"),
    "workflow.trigger.materialization_failed": tx("触发执行失败，等待重试", "Trigger failed and will retry"),
  };
  return labels[code];
}
