"use client";

import { useState } from "react";
import type { DigitalEmployeeShowcaseAgentRecord } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";

type AgentAccessRequestDraft = {
  requestType: "fork_copy" | "channel_use";
  targetChannelName?: string;
  reason: string;
};

export function AgentAccessRequestModal({
  agent,
  pending,
  tx,
  onClose,
  onSubmit,
}: {
  readonly agent: DigitalEmployeeShowcaseAgentRecord;
  readonly pending: boolean;
  readonly tx: (zh: string, en: string) => string;
  readonly onClose: () => void;
  readonly onSubmit: (draft: AgentAccessRequestDraft) => void;
}) {
  const [reason, setReason] = useState("");
  const defaultRequestType = agent.requestableActions.includes("fork_copy")
    ? "fork_copy"
    : agent.requestableActions[0] ?? "fork_copy";
  const [requestType, setRequestType] = useState<AgentAccessRequestDraft["requestType"]>(defaultRequestType);
  const [targetChannelName, setTargetChannelName] = useState(agent.commonChannels[0] ?? "");
  const canRequestCopy = agent.requestableActions.includes("fork_copy");
  const canRequestChannelUse = agent.requestableActions.includes("channel_use") && agent.commonChannels.length > 0;
  const effectiveRequestType = requestType === "channel_use" && !canRequestChannelUse ? "fork_copy" : requestType;

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label={tx("申请数字员工权限", "Request digital employee access")}
        className="modal-card agent-access-request-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            requestType: effectiveRequestType,
            targetChannelName: effectiveRequestType === "channel_use" ? targetChannelName : undefined,
            reason,
          });
        }}
      >
        <div className="modal-card__header">
          <div>
            <span className="modal-card__eyebrow">{tx("数字员工展板", "Digital employee showcase")}</span>
            <h2>{tx("申请数字员工权限", "Request digital employee access")}</h2>
          </div>
          <button
            aria-label={tx("关闭", "Close")}
            className="modal-icon-button"
            disabled={pending}
            onClick={onClose}
            type="button"
          >
            <AppIcon name="close" />
          </button>
        </div>

        <div className="agent-access-request-modal__target">
          <strong>{agent.name}</strong>
          <span>{agent.role} · {agent.managedByLabel}</span>
        </div>

        <fieldset className="agent-access-request-modal__request-type">
          <legend>{tx("申请类型", "Request type")}</legend>
          <label className={effectiveRequestType === "fork_copy" ? "agent-access-request-modal__option agent-access-request-modal__option--active" : "agent-access-request-modal__option"}>
            <input
              checked={effectiveRequestType === "fork_copy"}
              disabled={pending || !canRequestCopy}
              name="agent-access-request-type"
              onChange={() => setRequestType("fork_copy")}
              type="radio"
              value="fork_copy"
            />
            <span>
              <strong>{tx("复制给我", "Copy to me")}</strong>
              <small>{tx("批准后生成复制邀请，接受时选择你的执行引擎。", "Approval creates a copy invitation; you choose your runtime when accepting.")}</small>
            </span>
          </label>
          {canRequestChannelUse ? (
            <label className={effectiveRequestType === "channel_use" ? "agent-access-request-modal__option agent-access-request-modal__option--active" : "agent-access-request-modal__option"}>
              <input
                checked={effectiveRequestType === "channel_use"}
                disabled={pending}
                name="agent-access-request-type"
                onChange={() => setRequestType("channel_use")}
                type="radio"
                value="channel_use"
              />
              <span>
                <strong>{tx("在频道使用", "Use in channel")}</strong>
                <small>{tx("批准后在指定共同频道开放调用，不复制配置。", "Approval enables use in a shared channel without copying configuration.")}</small>
              </span>
            </label>
          ) : null}
        </fieldset>

        {effectiveRequestType === "channel_use" ? (
          <label className="form-field">
            <span>{tx("目标频道", "Target channel")}</span>
            <select
              disabled={pending}
              onChange={(event) => setTargetChannelName(event.currentTarget.value)}
              value={targetChannelName}
            >
              {agent.commonChannels.map((channelName) => (
                <option key={channelName} value={channelName}>
                  #{channelName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="form-field">
          <span>{tx("申请说明", "Reason")}</span>
          <textarea
            maxLength={280}
            onChange={(event) => setReason(event.currentTarget.value)}
            placeholder={tx("简单说明你准备用它处理什么工作。", "Briefly explain what work you want to use it for.")}
            rows={4}
            value={reason}
          />
        </label>

        <div className="modal-card__actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? tx("发送中...", "Sending...") : tx("发送申请", "Send request")}
          </button>
        </div>
      </form>
    </div>
  );
}
