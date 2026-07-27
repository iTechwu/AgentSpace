"use client";

import { useState } from "react";
import type { OrgChartPageData, OrgChartNode } from "@/features/dashboard/data";
import { useLanguage } from "@/features/i18n/language-provider";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

type ViewMode = "tree" | "channel";

export function OrgChartPageClient({ data }: { data: OrgChartPageData }) {
  const { tx } = useLanguage();
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  return (
    <section className="page-shell org-chart-page">
      <section className="org-chart-shell">
      <div className="org-chart-toolbar">
        <h2>{tx("组织架构", "Organization")}</h2>
        <div className="org-chart-stats">
          <span>{tx(`${data.totalHumans} 人类`, `${data.totalHumans} humans`)}</span>
          <span>{tx(`${data.totalAgents} AI员工`, `${data.totalAgents} AI employees`)}</span>
        </div>
        <div className="org-chart-view-toggle">
          <button
            className={`org-chart-view-btn${viewMode === "tree" ? " org-chart-view-btn--active" : ""}`}
            onClick={() => setViewMode("tree")}
            type="button"
          >
            {tx("组织树", "Org Tree")}
          </button>
          <button
            className={`org-chart-view-btn${viewMode === "channel" ? " org-chart-view-btn--active" : ""}`}
            onClick={() => setViewMode("channel")}
            type="button"
          >
            {tx("按群组", "By Group")}
          </button>
        </div>
      </div>

      {viewMode === "tree" ? (
        <div className="org-chart-tree">
          <div className="org-chart-group">
            <h3 className="org-chart-group__title">{tx("人类成员", "Human Members")}</h3>
            <div className="org-chart-group__cards">
              {data.humans.length > 0 ? (
                data.humans.map((node) => <OrgCard key={node.id} node={node} tx={tx} />)
              ) : (
                <EmptyState
                  body={tx("这个工作区还没有人类成员记录。", "There are no human members recorded for this workspace yet.")}
                  eyebrow={tx("人类成员", "Humans")}
                  title={tx("暂无人类成员", "No human members")}
                />
              )}
            </div>
          </div>
          <div className="org-chart-group">
            <h3 className="org-chart-group__title">AI员工</h3>
            <div className="org-chart-group__cards">
              {data.agents.length > 0 ? (
                data.agents.map((node) => <OrgCard key={node.id} node={node} tx={tx} />)
              ) : (
                <EmptyState
                  body={tx("这个工作区还没有 AI员工 出现在组织架构里。", "There are no AI employees in this workspace org chart yet.")}
                  eyebrow="AI员工"
                  title={tx("暂无 AI员工", "No AI employees")}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="org-chart-channels">
          {data.channels.map((ch) => (
            <div className="org-chart-channel" key={ch.name}>
              <h3 className="org-chart-channel__name">{ch.name}</h3>
              <div className="org-chart-group__cards">
                {ch.agentNames.length > 0 ? (
                  ch.agentNames.map((name) => {
                    const agent = data.agents.find((a) => a.id === name);
                    return agent ? <OrgCard key={name} node={agent} tx={tx} /> : (
                      <div className="org-chart-card" key={name}>
                        <GeneratedAvatar
                          className="org-chart-card__avatar"
                          id={name}
                          name={name}
                          variant="agent"
                        />
                        <div className="org-chart-card__info">
                          <strong>{name}</strong>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    body={tx("这个频道下暂时没有可显示的组织成员。", "There are no visible members in this channel yet.")}
                    eyebrow={tx("频道视图", "Channel view")}
                    title={tx("暂无成员", "No members")}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      </section>
    </section>
  );
}

function OrgCard({ node, tx }: { node: OrgChartNode; tx: (zh: string, en: string) => string }) {
  return (
    <div className={`org-chart-card org-chart-card--${node.type}`}>
      <GeneratedAvatar
        className="org-chart-card__avatar"
        id={node.id}
        name={node.displayName}
        variant={node.type === "human" ? "human" : "agent"}
      />
      <div className="org-chart-card__info">
        <strong>{node.displayName}</strong>
        <span className="org-chart-card__role">{node.role}</span>
        {node.channels.length > 0 ? (
          <span className="org-chart-card__channels">
            {node.channels.slice(0, 3).map((ch) => `#${ch}`).join(" ")}
            {node.channels.length > 3 ? ` +${node.channels.length - 3}` : ""}
          </span>
        ) : null}
      </div>
      <span className={`org-chart-status org-chart-status--${node.status}`}>
        {node.status === "online" ? tx("在线", "Online") : tx("离线", "Offline")}
      </span>
    </div>
  );
}
