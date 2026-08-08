"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { EmptyState } from "@/shared/ui/empty-state";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import { useManualWorkflowRun } from "./use-manual-workflow-run";
import type { WorkflowCenterPageData, WorkflowListItem, WorkflowRunSummary } from "./workflow-types";

const RUNS_PAGE_SIZE = 50;

type WorkflowCenterTab = "plans" | "runs" | "templates";
type WorkflowStatusFilter = "all" | WorkflowListItem["status"];

const TABS: Array<{ id: WorkflowCenterTab; zh: string; en: string }> = [
  { id: "plans", zh: "计划", en: "Plans" },
  { id: "runs", zh: "运行", en: "Runs" },
  { id: "templates", zh: "模板", en: "Templates" },
];

export function WorkflowListClient({
  data,
  workspaceId,
  workspaceSlug,
}: {
  data: WorkflowCenterPageData;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const { tx } = useLanguage();
  const [tab, setTab] = useState<WorkflowCenterTab>("plans");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WorkflowStatusFilter>("all");
  // 运行历史游标分页（UIUX:运行历史分页）：SSR 已下发首页 + nextCursor/hasMore，前端按
  // (created_at DESC, id DESC) keyset 游标续拉下一页。hasMore/nextCursor 由服务端判定下发，
  // 避免旧 offset 分页在并发新增运行时漏记录或「加载更多」永不结束。runs 按已加载顺序追加。
  const [runs, setRuns] = useState<WorkflowRunSummary[]>(data.recentRuns);
  const [nextCursor, setNextCursor] = useState<string | null>(data.recentRunsNextCursor ?? null);
  const [hasMoreRuns, setHasMoreRuns] = useState<boolean>(data.recentRunsHasMore ?? false);
  const [totalRuns, setTotalRuns] = useState<number>(data.recentRunsTotal);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  // module-shell 会在缓存刷新后以同一 workspaceId 复用组件。记录服务端快照的组成字段，既覆盖
  // workspace 切换，也覆盖同工作区数据刷新；仅父组件普通重渲染且快照引用未变时不会丢弃分页结果。
  const [runSnapshotSource, setRunSnapshotSource] = useState(() => ({
    workspaceId,
    runs: data.recentRuns,
    nextCursor: data.recentRunsNextCursor ?? null,
    hasMore: data.recentRunsHasMore ?? false,
    total: data.recentRunsTotal,
  }));
  const incomingNextCursor = data.recentRunsNextCursor ?? null;
  const incomingHasMore = data.recentRunsHasMore ?? false;
  const runSnapshotChanged = workspaceId !== runSnapshotSource.workspaceId
    || data.recentRuns !== runSnapshotSource.runs
    || incomingNextCursor !== runSnapshotSource.nextCursor
    || incomingHasMore !== runSnapshotSource.hasMore
    || data.recentRunsTotal !== runSnapshotSource.total;
  if (runSnapshotChanged) {
    requestGenerationRef.current += 1;
    setRunSnapshotSource({
      workspaceId,
      runs: data.recentRuns,
      nextCursor: incomingNextCursor,
      hasMore: incomingHasMore,
      total: data.recentRunsTotal,
    });
    setRuns(data.recentRuns);
    setNextCursor(incomingNextCursor);
    setHasMoreRuns(incomingHasMore);
    setTotalRuns(data.recentRunsTotal);
    setLoadingMore(false);
    setLoadMoreError(null);
  }
  // workspace 与请求代次共同隔离过期响应；后者处理同一 workspace 的服务端快照刷新。
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return data.workflows.filter((workflow) =>
      (status === "all" || workflow.status === status) &&
      (!normalizedQuery || workflow.name.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [data.workflows, query, status]);

  async function loadMoreRuns(): Promise<void> {
    if (!nextCursor) return;
    const requestWorkspaceId = workspaceId;
    const requestGeneration = requestGenerationRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/workflow-runs?limit=${RUNS_PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
        { headers: { accept: "application/json" } },
      );
      // 不可解码的游标（400）：刷新首页，避免旧/损坏游标卡住"加载更多"。
      if (response.status === 400) {
        const refreshedResponse = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/workflow-runs?limit=${RUNS_PAGE_SIZE}`,
          { headers: { accept: "application/json" } },
        );
        if (!refreshedResponse.ok) throw new Error(`HTTP ${refreshedResponse.status}`);
        const refreshedPage = await readWorkflowRunsPage(refreshedResponse);
        if (workspaceIdRef.current !== requestWorkspaceId || requestGenerationRef.current !== requestGeneration) return;
        setRuns(refreshedPage.runs);
        setHasMoreRuns(refreshedPage.hasMore);
        setNextCursor(refreshedPage.nextCursor);
        setTotalRuns(refreshedPage.total);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await readWorkflowRunsPage(response);
      // workspace 或服务端首页快照已在请求在途期间变化：丢弃旧分页响应。
      if (workspaceIdRef.current !== requestWorkspaceId || requestGenerationRef.current !== requestGeneration) return;
      // 服务端识别出旧协议（114/115 无签名）游标并回退为首页：替换列表而非追加，
      // 否则首页会按 id 去重后拼到既有列表尾部。
      if (page.cursorReset) {
        setRuns(page.runs);
        setHasMoreRuns(page.hasMore);
        setNextCursor(page.nextCursor);
        setTotalRuns(page.total);
        return;
      }
      // 去重防御：游标分页正常不重叠；与 SSR 首页或并发刷新产生重复时按 id 合并。
      setRuns((previous) => {
        const seen = new Set(previous.map((run) => run.id));
        return [...previous, ...page.runs.filter((run) => !seen.has(run.id))];
      });
      setHasMoreRuns(page.hasMore);
      setNextCursor(page.nextCursor);
      setTotalRuns(page.total);
    } catch {
      if (workspaceIdRef.current !== requestWorkspaceId || requestGenerationRef.current !== requestGeneration) return;
      setLoadMoreError(tx("加载更多运行记录失败，请稍后重试。", "Failed to load more runs. Please try again."));
    } finally {
      if (workspaceIdRef.current === requestWorkspaceId && requestGenerationRef.current === requestGeneration) {
        setLoadingMore(false);
      }
    }
  }

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
          {runs.length > 0 ? (
            <>
              <div aria-label={tx("最近运行", "Recent runs")} className="workflow-center__list" role="list">
                {runs.map((run) => (
                  <div key={run.id} role="listitem">
                    <Link className="workflow-center__row" href={`/w/${workspaceSlug}/automations/runs/${run.id}`}>
                      <strong>{run.workflowName}</strong>
                      <span>{runStatusLabel(run.status, tx)}</span>
                      <span>{run.finishedAt ? formatCompactTimestamp(run.finishedAt) : tx("进行中", "In progress")}</span>
                    </Link>
                  </div>
                ))}
              </div>
              {hasMoreRuns ? (
                <div className="workflow-center__load-more">
                  <button
                    className="knowledge-btn"
                    disabled={loadingMore}
                    onClick={() => void loadMoreRuns()}
                    type="button"
                  >
                    {loadingMore ? tx("加载中…", "Loading…") : tx("加载更多", "Load more")}
                  </button>
                  <span>
                    {tx(`已加载 ${runs.length} / ${totalRuns} 条`, `${runs.length} of ${totalRuns} loaded`)}
                  </span>
                </div>
              ) : (
                <p className="workflow-center__load-more-summary">{tx(`共 ${totalRuns} 条运行记录`, `${totalRuns} runs in total`)}</p>
              )}
              {loadMoreError ? <p className="workflow-run__notice" role="alert">{loadMoreError}</p> : null}
            </>
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

async function readWorkflowRunsPage(response: Response): Promise<{
  runs: WorkflowRunSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  cursorReset?: boolean;
}> {
  return await response.json() as {
    runs: WorkflowRunSummary[];
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
    cursorReset?: boolean;
  };
}

function WorkflowPlanRow({ workflow, workspaceSlug }: { workflow: WorkflowListItem; workspaceSlug: string }) {
  const { tx } = useLanguage();
  // 运行控制逻辑与任务看板共用 useManualWorkflowRun，保证二次确认、错误展示与跳转路径一致。
  const { running, notice, run } = useManualWorkflowRun(workspaceSlug, tx, "list");
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
  return (
    <div role="listitem" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
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
          <button className="knowledge-btn" disabled={running} onClick={() => void run(workflow.id)} type="button">{running ? "启动中" : "立即运行"}</button>
        ) : null}
      </div>
      {notice ? <p className="workflow-run__notice" role="status" style={{ flexBasis: "100%" }}>{notice}</p> : null}
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
