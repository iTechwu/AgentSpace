"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { OrgChartPageData, OrgChartNode } from "@/features/dashboard/data";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";
import { WorkbenchPageFrame } from "@/shared/ui/workbench-page-frame";

type ViewMode = "tree" | "channel";
type Translator = (zh: string, en: string) => string;

export function OrgChartPageClient({ data }: { data: OrgChartPageData }) {
  const { tx } = useLanguage();
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const tabRefs = useRef<Record<ViewMode, HTMLButtonElement | null>>({ tree: null, channel: null });
  const treePanelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (viewMode !== "tree" || !treePanelRef.current) return;

    const panel = treePanelRef.current;
    panel.scrollLeft = Math.max(0, (panel.scrollWidth - panel.clientWidth) / 2);
  }, [data.totalAgents, data.totalHumans, viewMode]);

  function selectView(nextView: ViewMode) {
    setViewMode(nextView);
    tabRefs.current[nextView]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    event.preventDefault();
    const nextView = event.key === "ArrowLeft" || event.key === "Home" ? "tree" : "channel";
    selectView(nextView);
  }

  return (
    <WorkbenchPageFrame className="org-chart-page">
      <section className="org-chart-shell">
        <div className="org-chart-toolbar">
          <div className="org-chart-heading">
            <h2>{tx("组织架构", "Organization")}</h2>
            <div className="org-chart-stats" aria-label={tx("成员统计", "Member totals")}>
              <span>{tx(`${data.totalHumans} 人类成员`, `${data.totalHumans} humans`)}</span>
              <span>{tx(`${data.totalAgents} AI 员工`, `${data.totalAgents} AI employees`)}</span>
            </div>
          </div>
          <div className="org-chart-view-toggle" role="tablist" aria-label={tx("组织架构视图", "Organization views")}>
            <button
              aria-controls="org-chart-tree-panel"
              aria-selected={viewMode === "tree"}
              className={`org-chart-view-btn${viewMode === "tree" ? " org-chart-view-btn--active" : ""}`}
              id="org-chart-tree-tab"
              onClick={() => setViewMode("tree")}
              onKeyDown={handleTabKeyDown}
              ref={(element) => { tabRefs.current.tree = element; }}
              role="tab"
              tabIndex={viewMode === "tree" ? 0 : -1}
              type="button"
            >
              {tx("组织树", "Org Tree")}
            </button>
            <button
              aria-controls="org-chart-channel-panel"
              aria-selected={viewMode === "channel"}
              className={`org-chart-view-btn${viewMode === "channel" ? " org-chart-view-btn--active" : ""}`}
              id="org-chart-channel-tab"
              onClick={() => setViewMode("channel")}
              onKeyDown={handleTabKeyDown}
              ref={(element) => { tabRefs.current.channel = element; }}
              role="tab"
              tabIndex={viewMode === "channel" ? 0 : -1}
              type="button"
            >
              {tx("按群组", "By Group")}
            </button>
          </div>
        </div>

        {viewMode === "tree" ? (
          <div
            aria-labelledby="org-chart-tree-tab"
            className="org-chart-tree-panel"
            id="org-chart-tree-panel"
            ref={treePanelRef}
            role="tabpanel"
            tabIndex={0}
          >
            <div className="org-chart-hierarchy" role="tree" aria-label={tx("工作区组织架构", "Workspace organization chart")}>
              <div
                aria-label={tx(`工作区全体，共 ${data.totalHumans + data.totalAgents} 名成员`, `Entire workspace, ${data.totalHumans + data.totalAgents} members`)}
                aria-level={1}
                className="org-chart-root"
                role="treeitem"
              >
                <div className="org-chart-root__node">
                  <span className="org-chart-root__icon"><AppIcon name="orgChart" /></span>
                  <span className="org-chart-root__copy">
                    <strong>{tx("工作区全体", "Entire Workspace")}</strong>
                    <small>{tx(`${data.totalHumans + data.totalAgents} 名成员`, `${data.totalHumans + data.totalAgents} members`)}</small>
                  </span>
                </div>

                <div className="org-chart-branches" role="group">
                  <OrgUnit
                    emptyBody={tx("尚未添加人类成员", "No human members yet")}
                    icon="contacts"
                    label={tx("人类团队", "Human Team")}
                    nodes={data.humans}
                    tx={tx}
                    type="human"
                  />
                  <OrgUnit
                    emptyBody={tx("尚未添加 AI 员工", "No AI employees yet")}
                    icon="agents"
                    label={tx("AI 员工团队", "AI Employee Team")}
                    nodes={data.agents}
                    tx={tx}
                    type="agent"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div
            aria-labelledby="org-chart-channel-tab"
            className="org-chart-channels"
            id="org-chart-channel-panel"
            role="tabpanel"
            tabIndex={0}
          >
            {data.channels.length > 0 ? data.channels.map((channel) => (
              <section className="org-chart-channel" key={channel.name}>
                <div className="org-chart-channel__header">
                  <h3 className="org-chart-channel__name">#{channel.name}</h3>
                  <span>{tx(`${channel.agentNames.length} 名成员`, `${channel.agentNames.length} members`)}</span>
                </div>
                <div className="org-chart-group__cards">
                  {channel.agentNames.length > 0 ? (
                    channel.agentNames.map((name) => {
                      const agent = data.agents.find((item) => item.id === name);
                      return agent ? <OrgCard key={name} node={agent} tx={tx} /> : (
                        <div className="org-chart-card org-chart-card--agent" key={name}>
                          <GeneratedAvatar className="org-chart-card__avatar" id={name} name={name} variant="agent" />
                          <div className="org-chart-card__info"><strong>{name}</strong></div>
                        </div>
                      );
                    })
                  ) : (
                    <EmptyState
                      body={tx("这个群组下暂时没有可显示的组织成员。", "There are no visible members in this group yet.")}
                      eyebrow={tx("群组视图", "Group view")}
                      title={tx("暂无成员", "No members")}
                    />
                  )}
                </div>
              </section>
            )) : (
              <EmptyState
                body={tx("创建群组后，可以在这里按协作关系查看 AI 员工。", "Create a group to view AI employees by collaboration context.")}
                eyebrow={tx("群组视图", "Group view")}
                title={tx("暂无群组", "No groups")}
              />
            )}
          </div>
        )}
      </section>
    </WorkbenchPageFrame>
  );
}

function OrgUnit({
  emptyBody,
  icon,
  label,
  nodes,
  tx,
  type,
}: {
  emptyBody: string;
  icon: AppIconName;
  label: string;
  nodes: OrgChartNode[];
  tx: Translator;
  type: OrgChartNode["type"];
}) {
  return (
    <section
      aria-label={tx(`${label}，${nodes.length} 名成员`, `${label}, ${nodes.length} members`)}
      aria-level={2}
      className={`org-chart-branch org-chart-branch--${type}`}
      role="treeitem"
    >
      <div className="org-chart-unit">
        <span className="org-chart-unit__icon"><AppIcon name={icon} /></span>
        <span className="org-chart-unit__copy">
          <strong>{label}</strong>
          <small>{tx(`${nodes.length} 名成员`, `${nodes.length} members`)}</small>
        </span>
      </div>
      <div className="org-chart-members" role="group">
        {nodes.length > 0 ? nodes.map((node) => (
          <div className="org-chart-member-branch" key={node.id}>
            <OrgCard node={node} treeItem tx={tx} />
          </div>
        )) : (
          <div className="org-chart-member-branch">
            <div className="org-chart-empty-node">
              <span className="org-chart-empty-node__mark" aria-hidden="true" />
              <span>{emptyBody}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function OrgCard({ node, treeItem = false, tx }: { node: OrgChartNode; treeItem?: boolean; tx: Translator }) {
  const statusLabel = node.status === "online" ? tx("在线", "Online") : tx("离线", "Offline");

  return (
    <article
      aria-label={treeItem ? `${node.displayName}，${node.role}，${statusLabel}` : undefined}
      aria-level={treeItem ? 3 : undefined}
      className={`org-chart-card org-chart-card--${node.type}`}
      role={treeItem ? "treeitem" : undefined}
    >
      <GeneratedAvatar
        className="org-chart-card__avatar"
        id={node.id}
        name={node.displayName}
        variant={node.type === "human" ? "human" : "agent"}
      />
      <div className="org-chart-card__info">
        <strong title={node.displayName}>{node.displayName}</strong>
        <span className="org-chart-card__role">{node.role}</span>
        {node.channels.length > 0 ? (
          <span className="org-chart-card__channels" title={node.channels.map((channel) => `#${channel}`).join(" ")}>
            {node.channels.slice(0, 3).map((channel) => `#${channel}`).join(" ")}
            {node.channels.length > 3 ? ` +${node.channels.length - 3}` : ""}
          </span>
        ) : null}
      </div>
      <span className={`org-chart-status org-chart-status--${node.status}`}>{statusLabel}</span>
    </article>
  );
}
