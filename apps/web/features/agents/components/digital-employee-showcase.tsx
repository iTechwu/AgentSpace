"use client";

import { useMemo, useState } from "react";
import type { DigitalEmployeeShowcaseAgentRecord } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";

type ShowcaseFilter = "all" | "requestable" | "channel" | "ready" | "mine" | "pending";
type ShowcaseSort = "recommended" | "recent" | "skills" | "knowledge";

export function DigitalEmployeeShowcase({
  agents,
  pending,
  tx,
  onApproveRequest,
  onCancelRequest,
  onOpenAgent,
  onOpenInvitationInbox,
  onRejectRequest,
  onRequestCopy,
}: {
  readonly agents: DigitalEmployeeShowcaseAgentRecord[];
  readonly pending: boolean;
  readonly tx: (zh: string, en: string) => string;
  readonly onApproveRequest: (requestId: string) => void;
  readonly onCancelRequest: (requestId: string) => void;
  readonly onOpenAgent: (agentName: string) => void;
  readonly onOpenInvitationInbox: () => void;
  readonly onRejectRequest: (requestId: string) => void;
  readonly onRequestCopy: (agent: DigitalEmployeeShowcaseAgentRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ShowcaseFilter>("all");
  const [sort, setSort] = useState<ShowcaseSort>("recommended");
  const reviewItems = useMemo(
    () => agents.flatMap((agent) => agent.reviewableRequests.map((request) => ({ agent, request }))),
    [agents],
  );
  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return agents.filter((agent) => {
      if (filter === "requestable" && agent.requestableActions.length === 0) {
        return false;
      }
      if (filter === "channel" && !(agent.channelMemberAccess === "enabled" && agent.commonChannels.length > 0)) {
        return false;
      }
      if (filter === "ready" && agent.readiness.status !== "ready") {
        return false;
      }
      if (filter === "mine" && !agent.canManage) {
        return false;
      }
      if (filter === "pending" && !agent.pendingRequest && agent.reviewableRequests.length === 0) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return [
        agent.name,
        agent.internalName,
        agent.role,
        agent.summary,
        agent.fit,
        agent.managedByLabel,
        agent.readiness.label,
        ...agent.traits,
        ...agent.channels,
        ...agent.commonChannels,
        ...agent.skillHighlights.map((skill) => `${skill.name} ${skill.summary ?? ""}`),
        ...agent.knowledgeHighlights.map((page) => page.title),
        ...agent.usageHints,
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    }).sort((left, right) => compareShowcaseAgents(left, right, sort));
  }, [agents, filter, query, sort]);

  const pendingReviewCount = reviewItems.length;
  const requestableCount = agents.filter((agent) => agent.requestableActions.length > 0).length;
  const channelUsableCount = agents.filter((agent) => agent.channelMemberAccess === "enabled" && agent.commonChannels.length > 0).length;

  return (
    <section className="digital-employee-showcase">
      <div className="digital-employee-showcase__header">
        <div>
          <span className="digital-employee-showcase__eyebrow">{tx("Workspace 目录", "Workspace directory")}</span>
          <h2>{tx("数字员工展板", "Digital employee showcase")}</h2>
        </div>
        <div className="digital-employee-showcase__stats" aria-label={tx("展板摘要", "Showcase summary")}>
          <span>{tx(`${agents.length} 个 AI员工`, `${agents.length} AI employees`)}</span>
          <span>{tx(`${requestableCount} 个可申请`, `${requestableCount} requestable`)}</span>
          <span>{tx(`${channelUsableCount} 个可频道调用`, `${channelUsableCount} channel-ready`)}</span>
          <span>{tx(`${pendingReviewCount} 个待处理`, `${pendingReviewCount} to review`)}</span>
        </div>
      </div>

      {reviewItems.length > 0 ? (
        <section className="digital-employee-showcase__review-queue" aria-label={tx("待我审批", "Needs my review")}>
          <div className="digital-employee-showcase__review-header">
            <div>
              <span>{tx("待我审批", "Needs my review")}</span>
              <h3>{tx(`${reviewItems.length} 个数字员工申请`, `${reviewItems.length} digital employee request(s)`)}</h3>
            </div>
          </div>
          <div className="digital-employee-showcase__review-list">
            {reviewItems.map(({ agent, request }) => (
              <div className="digital-employee-showcase__review-item" key={request.id}>
                <div>
                  <strong>{agent.name}</strong>
                  <span>
                    {request.requesterDisplayName ?? request.requesterUserId}
                    {" · "}
                    {formatRequestType(request, tx)}
                  </span>
                  {request.reason ? <p>{request.reason}</p> : null}
                </div>
                <div>
                  <button disabled={pending} onClick={() => onApproveRequest(request.id)} type="button">
                    {tx("批准", "Approve")}
                  </button>
                  <button disabled={pending} onClick={() => onRejectRequest(request.id)} type="button">
                    {tx("拒绝", "Reject")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="digital-employee-showcase__toolbar">
        <label className="digital-employee-showcase__search">
          <AppIcon name="search" />
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={tx("搜索名字、角色、频道或能力", "Search name, role, channel, or capability")}
            value={query}
          />
        </label>
        <div className="digital-employee-showcase__filters" role="tablist" aria-label={tx("展板筛选", "Showcase filters")}>
          {[
            { key: "all" as const, label: tx("全部", "All") },
            { key: "requestable" as const, label: tx("可申请", "Requestable") },
            { key: "channel" as const, label: tx("可频道调用", "Channel-ready") },
            { key: "ready" as const, label: tx("可用", "Ready") },
            { key: "mine" as const, label: tx("我管理", "Managed") },
            { key: "pending" as const, label: tx("待处理", "Pending") },
          ].map((item) => (
            <button
              className={`digital-employee-showcase__filter${filter === item.key ? " digital-employee-showcase__filter--active" : ""}`}
              key={item.key}
              onClick={() => setFilter(item.key)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="digital-employee-showcase__sort">
          <span>{tx("排序", "Sort")}</span>
          <select onChange={(event) => setSort(event.currentTarget.value as ShowcaseSort)} value={sort}>
            <option value="recommended">{tx("推荐优先", "Recommended")}</option>
            <option value="recent">{tx("最近活跃", "Recently active")}</option>
            <option value="skills">{tx("技能数量", "Skill count")}</option>
            <option value="knowledge">{tx("知识数量", "Knowledge count")}</option>
          </select>
        </label>
      </div>

      {filteredAgents.length > 0 ? (
        <div className="digital-employee-showcase__grid">
          {filteredAgents.map((agent) => (
            <article className="digital-employee-card" key={agent.id}>
              <div className="digital-employee-card__topline">
                <div className="digital-employee-card__avatar">
                  <AppIcon name="agents" />
                </div>
                <div className="digital-employee-card__title">
                  <h3>{agent.name}</h3>
                  <span>{agent.internalName}</span>
                </div>
                <span className={`digital-employee-card__readiness digital-employee-card__readiness--${agent.readiness.status}`}>
                  {formatReadinessLabel(agent.readiness, tx)}
                </span>
              </div>

              <p className="digital-employee-card__role">{agent.role}</p>
              <p className="digital-employee-card__summary">{agent.summary || agent.fit || tx("暂无公开简介。", "No public summary yet.")}</p>

              <div className="digital-employee-card__meta">
                <span>{agent.managedByLabel}</span>
                <span>{tx(`${agent.skillCount} skills`, `${agent.skillCount} skills`)}</span>
                <span>{tx(`${agent.knowledgeCount} 知识`, `${agent.knowledgeCount} knowledge`)}</span>
                <span>{agent.statusLabel}</span>
              </div>

              {agent.skillHighlights.length > 0 || agent.knowledgeHighlights.length > 0 ? (
                <div className="digital-employee-card__highlights">
                  {agent.skillHighlights.length > 0 ? (
                    <div>
                      <span>{tx("Top skills", "Top skills")}</span>
                      <p>{agent.skillHighlights.map((skill) => skill.name).join("、")}</p>
                    </div>
                  ) : null}
                  {agent.knowledgeHighlights.length > 0 ? (
                    <div>
                      <span>{tx("知识覆盖", "Knowledge")}</span>
                      <p>{agent.knowledgeHighlights.map((page) => page.title).join("、")}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="digital-employee-card__chips">
                {(agent.traits.length > 0 ? agent.traits : agent.usageHints.length > 0 ? agent.usageHints : agent.tags).slice(0, 5).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>

              {agent.commonChannels.length > 0 && agent.channelMemberAccess === "enabled" ? (
                <div className="digital-employee-card__availability">
                  <AppIcon name="checkCircle" />
                  <span>{tx(`可在共同频道调用：${agent.commonChannels.join("、")}`, `Usable in shared channels: ${agent.commonChannels.join(", ")}`)}</span>
                </div>
              ) : null}

              {agent.pendingRequest ? (
                <div className="digital-employee-card__notice">
                  <AppIcon name="info" />
                  <span>{tx(`${formatRequestType(agent.pendingRequest, tx)}待处理`, `${formatRequestType(agent.pendingRequest, tx)} pending`)}</span>
                  <button disabled={pending} onClick={() => onCancelRequest(agent.pendingRequest!.id)} type="button">
                    {tx("取消", "Cancel")}
                  </button>
                </div>
              ) : agent.latestRequest?.status === "approved" && agent.latestRequest.requestType === "channel_use" ? (
                <div className="digital-employee-card__notice digital-employee-card__notice--approved">
                  <AppIcon name="checkCircle" />
                  <span>{tx("频道使用申请已批准", "Channel use request approved")}</span>
                </div>
              ) : agent.latestRequest?.status === "rejected" ? (
                <div className="digital-employee-card__notice digital-employee-card__notice--muted">
                  <AppIcon name="alertCircle" />
                  <span>{tx("最近一次申请已被拒绝，可重新申请", "Last request was rejected. You can request again.")}</span>
                </div>
              ) : null}

              {agent.reviewableRequests.length > 0 ? (
                <div className="digital-employee-card__review">
                  <strong>{tx("待你处理", "Needs your review")}</strong>
                  {agent.reviewableRequests.map((request) => (
                    <div className="digital-employee-card__review-row" key={request.id}>
                      <span>
                        {request.requesterDisplayName ?? request.requesterUserId}
                        {" · "}
                        {formatRequestType(request, tx)}
                      </span>
                      <div>
                        <button disabled={pending} onClick={() => onApproveRequest(request.id)} type="button">
                          {tx("批准", "Approve")}
                        </button>
                        <button disabled={pending} onClick={() => onRejectRequest(request.id)} type="button">
                          {tx("拒绝", "Reject")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="digital-employee-card__actions">
                {agent.canManage ? (
                  <button className="secondary-button" onClick={() => onOpenAgent(agent.internalName)} type="button">
                    {tx("管理", "Manage")}
                  </button>
                ) : agent.pendingForkInvitation ? (
                  <button className="primary-button" onClick={onOpenInvitationInbox} type="button">
                    {tx("接受复制邀请", "Accept copy invite")}
                  </button>
                ) : agent.pendingRequest ? (
                  <button className="primary-button" disabled type="button">
                    {tx("已申请", "Requested")}
                  </button>
                ) : (
                  <button className="primary-button" disabled={pending || agent.requestableActions.length === 0} onClick={() => onRequestCopy(agent)} type="button">
                    {agent.requestableActions.includes("channel_use")
                      ? tx("申请使用权限", "Request access")
                      : tx("申请复制给我", "Request a copy")}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          body={tx("换个关键词或筛选条件试试。", "Try a different keyword or filter.")}
          title={tx("没有匹配的数字员工", "No matching digital employees")}
        />
      )}
    </section>
  );
}

function formatRequestType(
  request: DigitalEmployeeShowcaseAgentRecord["reviewableRequests"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (request.requestType === "channel_use") {
    return request.targetChannelName
      ? tx(`频道调用 #${request.targetChannelName}`, `Channel use #${request.targetChannelName}`)
      : tx("频道调用", "Channel use");
  }
  return tx("复制申请", "Copy request");
}

function formatReadinessLabel(
  readiness: DigitalEmployeeShowcaseAgentRecord["readiness"],
  tx: (zh: string, en: string) => string,
): string {
  if (readiness.status === "provider_unusable") {
    return tx("Provider 不可用", "Provider unavailable");
  }
  if (readiness.status === "runtime_offline") {
    return tx("执行引擎离线", "Runtime offline");
  }
  if (readiness.status === "needs_runtime") {
    return tx("未绑定执行引擎", "Needs runtime");
  }
  if (readiness.status === "ready") {
    return tx("可用", "Ready");
  }
  return tx("状态未知", "Unknown");
}

function compareShowcaseAgents(
  left: DigitalEmployeeShowcaseAgentRecord,
  right: DigitalEmployeeShowcaseAgentRecord,
  sort: ShowcaseSort,
): number {
  if (sort === "recent") {
    return compareDateDesc(left.lastActivityAt, right.lastActivityAt) || left.name.localeCompare(right.name);
  }
  if (sort === "skills") {
    return right.skillCount - left.skillCount || left.name.localeCompare(right.name);
  }
  if (sort === "knowledge") {
    return right.knowledgeCount - left.knowledgeCount || left.name.localeCompare(right.name);
  }
  const leftScore = recommendationScore(left);
  const rightScore = recommendationScore(right);
  return rightScore - leftScore || left.name.localeCompare(right.name);
}

function recommendationScore(agent: DigitalEmployeeShowcaseAgentRecord): number {
  return (
    agent.reviewableRequests.length * 100 +
    agent.requestableActions.length * 20 +
    (agent.readiness.status === "ready" ? 10 : 0) +
    (agent.channelMemberAccess === "enabled" && agent.commonChannels.length > 0 ? 8 : 0) +
    Math.min(agent.skillCount, 6) +
    Math.min(agent.knowledgeCount, 6)
  );
}

function compareDateDesc(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return rightTime - leftTime;
}
