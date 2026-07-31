"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";

export interface PlatformWorkspaceSummary {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly managedRuntimeCount: number;
  readonly onlineRuntimeCount: number;
  readonly needsAttentionRuntimeCount: number;
  readonly periodActualCostUsd: number;
}

export interface PlatformAuditEntry {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly code?: string;
  readonly createdAt: string;
}

interface PlatformConsoleClientProps {
  readonly operator: {
    readonly displayName: string;
    readonly email: string;
  };
  readonly periodLabel: string;
  readonly workspaces: PlatformWorkspaceSummary[];
  readonly recentAudit: PlatformAuditEntry[];
}

type WorkspaceFilter = "all" | "attention" | "offline" | "empty";
type WorkspaceSort = "health" | "runtime" | "cost" | "name";

const FILTERS: ReadonlyArray<{ value: WorkspaceFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需处理" },
  { value: "offline", label: "有离线" },
  { value: "empty", label: "无能力" },
];

export function PlatformConsoleClient({
  operator,
  periodLabel,
  workspaces,
  recentAudit,
}: PlatformConsoleClientProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [sort, setSort] = useState<WorkspaceSort>("health");

  const overview = useMemo(() => {
    const totalRuntimes = workspaces.reduce((total, workspace) => total + workspace.managedRuntimeCount, 0);
    const onlineRuntimes = workspaces.reduce((total, workspace) => total + workspace.onlineRuntimeCount, 0);
    const attentionRuntimes = workspaces.reduce((total, workspace) => total + workspace.needsAttentionRuntimeCount, 0);
    const totalCost = workspaces.reduce((total, workspace) => total + workspace.periodActualCostUsd, 0);
    const attentionWorkspaces = workspaces.filter((workspace) => workspace.needsAttentionRuntimeCount > 0);
    const emptyWorkspaces = workspaces.filter((workspace) => workspace.managedRuntimeCount === 0);
    return {
      totalRuntimes,
      onlineRuntimes,
      attentionRuntimes,
      totalCost,
      attentionWorkspaces,
      emptyWorkspaces,
      availability: totalRuntimes === 0 ? 0 : Math.round((onlineRuntimes / totalRuntimes) * 100),
    };
  }, [workspaces]);

  const visibleWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return workspaces
      .filter((workspace) => {
        if (normalizedQuery && !`${workspace.name} ${workspace.slug}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) {
          return false;
        }
        if (filter === "attention") return workspace.needsAttentionRuntimeCount > 0;
        if (filter === "offline") return workspace.onlineRuntimeCount < workspace.managedRuntimeCount;
        if (filter === "empty") return workspace.managedRuntimeCount === 0;
        return true;
      })
      .sort((a, b) => compareWorkspaces(a, b, sort));
  }, [filter, query, sort, workspaces]);

  const platformState = overview.attentionRuntimes > 0
    ? { label: "需要介入", detail: `${overview.attentionWorkspaces.length} 个工作区存在待处理项`, tone: "attention" as const }
    : overview.onlineRuntimes < overview.totalRuntimes
      ? { label: "部分能力离线", detail: "建议检查节点心跳与网络连接", tone: "warning" as const }
      : { label: "运行平稳", detail: "所有受管 Runtime 均可用", tone: "healthy" as const };

  return (
    <div className="platform-console-shell">
      <aside className="platform-console-sidebar">
        <div className="platform-console-brand">
          <span className="platform-console-brand__mark" aria-hidden="true">D</span>
          <div>
            <strong>DOFE OPS</strong>
            <span>平台运维中心</span>
          </div>
        </div>

        <nav className="platform-console-nav" aria-label="平台运维导航">
          <span className="platform-console-nav__label">工作台</span>
          <Link className="platform-console-nav__item platform-console-nav__item--active" href="/platform" aria-current="page">
            <AppIcon name="performance" />
            <span>运行概览</span>
          </Link>
          <Link className="platform-console-nav__item" href="/platform/audit">
            <AppIcon name="approvals" />
            <span>平台审计</span>
          </Link>
          <span className="platform-console-nav__label">快速入口</span>
          <Link className="platform-console-nav__item" href="/">
            <AppIcon name="arrowLeft" />
            <span>返回团队空间</span>
          </Link>
        </nav>

        <div className="platform-console-scope">
          <AppIcon name="info" />
          <div>
            <strong>只读跨团队视图</strong>
            <span>所有操作均记录真实操作者</span>
          </div>
        </div>

        <div className="platform-console-operator">
          <span className="platform-console-operator__avatar" aria-hidden="true">
            {operator.displayName.trim().slice(0, 1).toLocaleUpperCase("zh-CN") || "O"}
          </span>
          <div>
            <strong>{operator.displayName || "平台运维"}</strong>
            <span>{operator.email || "Platform administrator"}</span>
          </div>
        </div>
      </aside>

      <main className="platform-console-page">
        <header className="platform-console-header">
          <div className="platform-console-header__copy">
            <span className="platform-console-header__eyebrow">PLATFORM OPERATIONS</span>
            <h1>平台运维控制台</h1>
            <p>集中查看团队运行状态、受管执行能力与本周期成本。</p>
          </div>
          <div className={`platform-console-health platform-console-health--${platformState.tone}`}>
            <span className="platform-console-health__signal" aria-hidden="true" />
            <div>
              <strong>{platformState.label}</strong>
              <span>{platformState.detail}</span>
            </div>
          </div>
        </header>

        <section className="platform-console-stats" aria-label="平台概览">
          <OverviewMetric
            icon="groups"
            label="团队工作区"
            value={formatInteger(workspaces.length)}
            detail={`${overview.emptyWorkspaces.length} 个尚未配置 Runtime`}
          />
          <OverviewMetric
            icon="containers"
            label="受管 Runtime"
            value={`${formatInteger(overview.onlineRuntimes)} / ${formatInteger(overview.totalRuntimes)}`}
            detail={`在线率 ${overview.availability}%`}
            progress={overview.availability}
          />
          <OverviewMetric
            icon="alertCircle"
            label="需关注 Runtime"
            value={formatInteger(overview.attentionRuntimes)}
            detail={overview.attentionRuntimes > 0 ? `影响 ${overview.attentionWorkspaces.length} 个工作区` : "当前无待处理项"}
            tone={overview.attentionRuntimes > 0 ? "attention" : "healthy"}
          />
          <OverviewMetric
            icon="costs"
            label="本周期实际成本"
            value={formatCny(overview.totalCost)}
            detail={periodLabel}
          />
        </section>

        <div className="platform-console-layout">
          <section className="platform-console-workspaces" aria-labelledby="platform-workspaces-title">
            <div className="platform-console-section-heading">
              <div>
                <span>WORKSPACES</span>
                <h2 id="platform-workspaces-title">工作区运行状态</h2>
                <p>按健康度定位异常，并进入团队执行能力页面查看明细。</p>
              </div>
              <span className="platform-console-section-heading__count">{visibleWorkspaces.length} / {workspaces.length}</span>
            </div>

            <div className="platform-console-toolbar">
              <label className="platform-console-search">
                <span className="platform-console-visually-hidden">搜索工作区</span>
                <AppIcon name="search" />
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或标识"
                  type="search"
                  value={query}
                />
              </label>
              <div className="platform-console-filter" role="group" aria-label="健康状态筛选">
                {FILTERS.map((item) => (
                  <button
                    aria-pressed={filter === item.value}
                    className={filter === item.value ? "platform-console-filter__button platform-console-filter__button--active" : "platform-console-filter__button"}
                    key={item.value}
                    onClick={() => setFilter(item.value)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="platform-console-sort">
                <span>排序</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as WorkspaceSort)}>
                  <option value="health">优先显示异常</option>
                  <option value="runtime">Runtime 数量</option>
                  <option value="cost">成本从高到低</option>
                  <option value="name">工作区名称</option>
                </select>
              </label>
            </div>

            <div className="platform-console-table-wrap">
              <table className="platform-console-table" aria-label="工作区运行状态">
                <thead>
                  <tr>
                    <th scope="col">工作区</th>
                    <th scope="col">健康状态</th>
                    <th scope="col">Runtime</th>
                    <th scope="col">在线</th>
                    <th scope="col">需关注</th>
                    <th scope="col">本周期成本</th>
                    <th scope="col"><span className="platform-console-visually-hidden">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWorkspaces.map((workspace) => {
                    const status = presentWorkspaceStatus(workspace);
                    const onlinePercent = workspace.managedRuntimeCount === 0
                      ? 0
                      : Math.round((workspace.onlineRuntimeCount / workspace.managedRuntimeCount) * 100);
                    return (
                      <tr key={workspace.workspaceId}>
                        <td>
                          <Link className="platform-console-workspace-name" href={`/w/${encodeURIComponent(workspace.slug)}/runtimes`}>
                            <span className="platform-console-workspace-name__mark" aria-hidden="true">
                              {workspace.name.trim().slice(0, 1).toLocaleUpperCase("zh-CN") || "W"}
                            </span>
                            <span>
                              <strong>{workspace.name}</strong>
                              <small>{workspace.slug}</small>
                            </span>
                          </Link>
                        </td>
                        <td><StatusBadge label={status.label} tone={status.tone} /></td>
                        <td className="platform-console-table__number">{formatInteger(workspace.managedRuntimeCount)}</td>
                        <td>
                          <div className="platform-console-online-cell">
                            <span>{formatInteger(workspace.onlineRuntimeCount)}</span>
                            <span className="platform-console-mini-progress" aria-label={`在线率 ${onlinePercent}%`}>
                              <span style={{ width: `${onlinePercent}%` }} />
                            </span>
                          </div>
                        </td>
                        <td className={workspace.needsAttentionRuntimeCount > 0 ? "platform-console-table__attention" : "platform-console-table__muted"}>
                          {formatInteger(workspace.needsAttentionRuntimeCount)}
                        </td>
                        <td className="platform-console-table__cost">{formatCny(workspace.periodActualCostUsd)}</td>
                        <td>
                          <Link
                            aria-label={`查看 ${workspace.name} 的 Runtime`}
                            className="platform-console-row-action"
                            href={`/w/${encodeURIComponent(workspace.slug)}/runtimes`}
                            title="查看 Runtime"
                          >
                            <AppIcon name="arrowRight" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visibleWorkspaces.length === 0 ? (
                <div className="platform-console-empty">
                  <AppIcon name="search" />
                  <strong>没有符合条件的工作区</strong>
                  <span>调整搜索内容或健康状态筛选。</span>
                  <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button>
                </div>
              ) : null}
            </div>
          </section>

          <aside className="platform-console-insights" aria-label="运维洞察">
            <section className="platform-console-insight-section" aria-labelledby="platform-attention-title">
              <div className="platform-console-insight-section__header">
                <div>
                  <span>ATTENTION</span>
                  <h2 id="platform-attention-title">待处理概览</h2>
                </div>
                <span className={overview.attentionRuntimes > 0 ? "platform-console-count-badge platform-console-count-badge--attention" : "platform-console-count-badge"}>
                  {overview.attentionRuntimes}
                </span>
              </div>
              {overview.attentionWorkspaces.length > 0 ? (
                <ul className="platform-console-attention-list">
                  {overview.attentionWorkspaces.slice(0, 5).map((workspace) => (
                    <li key={workspace.workspaceId}>
                      <span className="platform-console-attention-list__icon"><AppIcon name="alertCircle" /></span>
                      <div>
                        <strong>{workspace.name}</strong>
                        <span>{workspace.needsAttentionRuntimeCount} 个 Runtime 需要介入</span>
                      </div>
                      <Link aria-label={`处理 ${workspace.name}`} href={`/w/${encodeURIComponent(workspace.slug)}/runtimes`}>
                        <AppIcon name="arrowRight" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="platform-console-all-clear">
                  <span><AppIcon name="checkCircle" /></span>
                  <div>
                    <strong>暂无需人工介入的 Runtime</strong>
                    <p>平台托管凭据与部署状态均正常。</p>
                  </div>
                </div>
              )}
            </section>

            <section className="platform-console-insight-section" aria-labelledby="platform-audit-title">
              <div className="platform-console-insight-section__header">
                <div>
                  <span>AUDIT TRAIL</span>
                  <h2 id="platform-audit-title">最近平台审计</h2>
                </div>
                <Link className="platform-console-text-link" href="/platform/audit">查看全部</Link>
              </div>
              {recentAudit.length > 0 ? (
                <ol className="platform-console-audit-list">
                  {recentAudit.slice(0, 6).map((entry) => (
                    <li key={entry.id}>
                      <span className={`platform-console-audit-list__dot platform-console-audit-list__dot--${presentAuditTone(entry.code)}`} aria-hidden="true" />
                      <div>
                        <strong>{entry.title}</strong>
                        {entry.note ? <p>{entry.note}</p> : null}
                        <time dateTime={entry.createdAt}>{formatAuditTime(entry.createdAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="platform-console-audit-empty">
                  <AppIcon name="approvals" />
                  <span>暂无平台审计事件</span>
                </div>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}

function OverviewMetric({
  icon,
  label,
  value,
  detail,
  progress,
  tone = "neutral",
}: {
  icon: AppIconName;
  label: string;
  value: string;
  detail: string;
  progress?: number;
  tone?: "neutral" | "healthy" | "attention";
}) {
  return (
    <article className={`platform-console-stat platform-console-stat--${tone}`}>
      <div className="platform-console-stat__topline">
        <span className="platform-console-stat__icon"><AppIcon name={icon} /></span>
        <span className="platform-console-stat__label">{label}</span>
      </div>
      <strong className="platform-console-stat__value">{value}</strong>
      <span className="platform-console-stat__detail">{detail}</span>
      {typeof progress === "number" ? (
        <span className="platform-console-stat__progress" aria-label={`在线率 ${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </span>
      ) : null}
    </article>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: WorkspaceStatus["tone"] }) {
  return (
    <span className={`platform-console-status platform-console-status--${tone}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

interface WorkspaceStatus {
  label: string;
  tone: "healthy" | "attention" | "warning" | "neutral";
}

function presentWorkspaceStatus(workspace: PlatformWorkspaceSummary): WorkspaceStatus {
  if (workspace.needsAttentionRuntimeCount > 0) return { label: "需处理", tone: "attention" };
  if (workspace.managedRuntimeCount === 0) return { label: "未配置", tone: "neutral" };
  if (workspace.onlineRuntimeCount < workspace.managedRuntimeCount) return { label: "部分离线", tone: "warning" };
  return { label: "运行正常", tone: "healthy" };
}

function compareWorkspaces(a: PlatformWorkspaceSummary, b: PlatformWorkspaceSummary, sort: WorkspaceSort): number {
  if (sort === "cost") return b.periodActualCostUsd - a.periodActualCostUsd || a.name.localeCompare(b.name, "zh-CN");
  if (sort === "runtime") return b.managedRuntimeCount - a.managedRuntimeCount || a.name.localeCompare(b.name, "zh-CN");
  if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
  const aOffline = a.managedRuntimeCount - a.onlineRuntimeCount;
  const bOffline = b.managedRuntimeCount - b.onlineRuntimeCount;
  return b.needsAttentionRuntimeCount - a.needsAttentionRuntimeCount
    || bOffline - aOffline
    || b.managedRuntimeCount - a.managedRuntimeCount
    || a.name.localeCompare(b.name, "zh-CN");
}

function presentAuditTone(code?: string): "neutral" | "warning" | "danger" {
  if (!code) return "neutral";
  if (/fail|error|denied|revoked/i.test(code)) return "danger";
  if (/warn|attention|recover|retry/i.test(code)) return "warning";
  return "neutral";
}

function formatCny(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}
