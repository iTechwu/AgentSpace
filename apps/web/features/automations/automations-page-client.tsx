"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AutoContinuationRunRecord, AutomationsPageData, ChannelDocumentRunRecord } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type {
  AutomationRule,
  AutomationTriggerType,
  AutomationActionType,
  AutomationConditionOperator,
} from "@dofe-agent/domain/workspace";
import {
  createAutomationRuleAction,
  toggleAutomationRuleAction,
  deleteAutomationRuleAction,
  stopAutoContinuationAction,
} from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { EmptyState } from "@/shared/ui/empty-state";
import { formatCompactTimestamp } from "@/shared/lib/time-format";

const TRIGGER_TYPES: Array<{ value: AutomationTriggerType; label: string; labelEn: string }> = [
  { value: "message_received", label: "消息到达", labelEn: "Message Received" },
  { value: "task_completed", label: "任务完成", labelEn: "Task Completed" },
  { value: "document_updated", label: "文档更新", labelEn: "Document Updated" },
  { value: "schedule", label: "定时触发", labelEn: "Schedule" },
];

const ACTION_TYPES: Array<{ value: AutomationActionType; label: string; labelEn: string }> = [
  { value: "send_message", label: "发送消息", labelEn: "Send Message" },
  { value: "create_task", label: "创建任务", labelEn: "Create Task" },
  { value: "mention_agent", label: "@AI员工", labelEn: "@AI employee" },
  { value: "update_table", label: "更新数据表", labelEn: "Update Table" },
  { value: "webhook", label: "Webhook", labelEn: "Webhook" },
];

const CONDITION_OPERATORS: Array<{ value: AutomationConditionOperator; label: string; labelEn: string }> = [
  { value: "contains", label: "包含", labelEn: "Contains" },
  { value: "equals", label: "等于", labelEn: "Equals" },
  { value: "matches", label: "匹配正则", labelEn: "Matches" },
];

const CONDITION_FIELDS: Array<{ value: string; label: string; labelEn: string; placeholder: string; placeholderEn: string }> = [
  {
    value: "message.text",
    label: "消息内容",
    labelEn: "Message text",
    placeholder: "例如：然后、报销、客户投诉",
    placeholderEn: "Example: then, invoice, customer complaint",
  },
  {
    value: "message.channel",
    label: "所在群组",
    labelEn: "Channel",
    placeholder: "例如：general、sales",
    placeholderEn: "Example: general, sales",
  },
  {
    value: "task.status",
    label: "任务状态",
    labelEn: "Task status",
    placeholder: "例如：completed",
    placeholderEn: "Example: completed",
  },
  {
    value: "document.title",
    label: "文档标题",
    labelEn: "Document title",
    placeholder: "例如：周报、计划",
    placeholderEn: "Example: report, plan",
  },
];

const RUN_STATUS_LABELS: Record<ChannelDocumentRunRecord["status"], { label: string; labelEn: string }> = {
  pending: { label: "等待中", labelEn: "Pending" },
  running: { label: "运行中", labelEn: "Running" },
  completed: { label: "已完成", labelEn: "Completed" },
  completed_with_warning: { label: "有警告", labelEn: "Warning" },
  failed: { label: "失败", labelEn: "Failed" },
};

const AUTO_CONTINUATION_STATUS_LABELS: Record<AutoContinuationRunRecord["status"], { label: string; labelEn: string; badge: string }> = {
  active: { label: "运行中", labelEn: "Active", badge: "running" },
  expired: { label: "已结束", labelEn: "Expired", badge: "completed" },
  stopped: { label: "已停止", labelEn: "Stopped", badge: "disabled" },
};

const BUILTIN_SEQUENCE_RULE_ID = "builtin:channel-sequential-then";
const BUILTIN_AUTO_CONTINUATION_RULE_ID = "builtin:auto-continuation-until";

function getConditionFieldLabel(field: string, tx: (zh: string, en: string) => string): string {
  const option = CONDITION_FIELDS.find((item) => item.value === field);
  return option ? tx(option.label, option.labelEn) : field;
}

function getConditionOperatorLabel(operator: AutomationConditionOperator, tx: (zh: string, en: string) => string): string {
  const option = CONDITION_OPERATORS.find((item) => item.value === operator);
  return option ? tx(option.label, option.labelEn) : operator;
}

function getQueueStatusLabel(status: string | undefined, tx: (zh: string, en: string) => string): string {
  switch (status) {
    case "queued":
      return tx("排队中", "Queued");
    case "claimed":
      return tx("已认领", "Claimed");
    case "running":
      return tx("执行中", "Running");
    case "completed":
      return tx("已完成", "Completed");
    case "failed":
      return tx("失败", "Failed");
    case "cancelled":
      return tx("已取消", "Cancelled");
    default:
      return tx("无队列任务", "No queued task");
  }
}

export function AutomationsPageClient({ data, onDataChanged }: { data: AutomationsPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createTriggerType, setCreateTriggerType] = useState<AutomationTriggerType>("message_received");
  const [createConditionField, setCreateConditionField] = useState("message.text");
  const [createConditionOperator, setCreateConditionOperator] = useState<AutomationConditionOperator>("contains");
  const [createConditionValue, setCreateConditionValue] = useState("");
  const [createActionType, setCreateActionType] = useState<AutomationActionType>("send_message");
  const [isPending, startTransition] = useTransition();
  const selectedRule = data.rules.find((rule) => rule.id === selectedId);
  const selectedBuiltinSequenceRule = selectedId === BUILTIN_SEQUENCE_RULE_ID;
  const selectedBuiltinAutoContinuationRule = selectedId === BUILTIN_AUTO_CONTINUATION_RULE_ID;
  const activeAutoContinuationRuns = data.autoContinuationRuns.filter((run) => run.status === "active");
  const selectedConditionField = CONDITION_FIELDS.find((field) => field.value === createConditionField) ?? CONDITION_FIELDS[0]!;
  const selectedTriggerLabel = TRIGGER_TYPES.find((trigger) => trigger.value === createTriggerType);
  const selectedOperatorLabel = CONDITION_OPERATORS.find((operator) => operator.value === createConditionOperator);
  const selectedActionLabel = ACTION_TYPES.find((action) => action.value === createActionType);

  function handleCreate(): void {
    if (!createName.trim()) return;
    const conditionValue = createConditionValue.trim();
    startTransition(async () => {
      await createAutomationRuleAction({
        name: createName.trim(),
        description: createDescription.trim(),
        trigger: { type: createTriggerType, config: {} },
        conditions: conditionValue
          ? [
              {
                field: createConditionField.trim() || "message.text",
                operator: createConditionOperator,
                value: conditionValue,
              },
            ]
          : [],
        actions: [{ type: createActionType, config: {} }],
      });
      setShowCreateModal(false);
      setCreateName("");
      setCreateDescription("");
      setCreateConditionField("message.text");
      setCreateConditionOperator("contains");
      setCreateConditionValue("");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleToggle(rule: AutomationRule): void {
    startTransition(async () => {
      await toggleAutomationRuleAction(rule.id, !rule.enabled);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteAutomationRuleAction(id);
      if (selectedId === id) setSelectedId(null);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleStopAutoContinuation(run: AutoContinuationRunRecord): void {
    startTransition(async () => {
      await stopAutoContinuationAction({
        channelName: run.channelName,
        agentId: run.agentId,
        contactId: run.contactId,
      });
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  return (
    <section className="page-shell automations-page">
      <div className="automations-layout">
        <div className="automations-header">
          <div>
            <h1>{tx("自动化工作流", "Automations")}</h1>
            <p className="automations-header__subtitle">
              {tx(
                `${data.totalCount} 条规则，${data.enabledCount} 条启用`,
                `${data.totalCount} rules, ${data.enabledCount} enabled`,
              )}
            </p>
          </div>
          <button
            className="knowledge-btn knowledge-btn--primary"
            onClick={() => setShowCreateModal(true)}
            type="button"
          >
            {tx("+ 新建规则", "+ New Rule")}
          </button>
        </div>

        <div className="automations-list">
          <>
            <div
              className={`automations-card${selectedBuiltinSequenceRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinSequenceRule ? null : BUILTIN_SEQUENCE_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("然后", "Then")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                </div>
              </div>
              <p className="automations-card__description">
                {tx("群消息里按顺序 @ 多个 AI员工 时，识别“然后”等顺序词并启动串行协作。", "Starts sequential collaboration when a channel message mentions multiple AI employees with markers such as then.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("群消息提及", "Channel mention")}</span>
                <span className="automations-card__conditions">→ {tx("包含 然后 / 再 / 之后", "contains then / next / after")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("串行协作", "Sequential collaboration")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("运行实例", "Runs")}: {data.documentRunCount}
              </div>
            </div>

            <div
              className={`automations-card${selectedBuiltinAutoContinuationRule ? " automations-card--selected" : ""}`}
              onClick={() => setSelectedId(selectedBuiltinAutoContinuationRule ? null : BUILTIN_AUTO_CONTINUATION_RULE_ID)}
            >
              <div className="automations-card__header">
                <div className="automations-card__title">
                  <strong>{tx("做…直到", "Do until")}</strong>
                  <span className="automations-card__badge automations-card__badge--enabled">
                    {tx("内置", "Built-in")}
                  </span>
                  {activeAutoContinuationRuns.length > 0 ? (
                    <span className="automations-card__badge automations-card__badge--run-running">
                      {tx(`${activeAutoContinuationRuns.length} 个运行中`, `${activeAutoContinuationRuns.length} active`)}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="automations-card__description">
                {tx("群消息 @ 单个 AI员工 并要求连续工作、持续工作或自动接管到某个时间时，持续排队下一轮任务直到截止。", "Keeps queueing follow-up work until a deadline when a channel message asks one AI employee to keep working or take over.")}
              </p>
              <div className="automations-card__flow">
                <span className="automations-card__trigger">{tx("群消息提及", "Channel mention")}</span>
                <span className="automations-card__conditions">→ {tx("包含 连续工作 / 自动接管 / 接管到", "contains keep working / take over / until")}</span>
                <span className="automations-card__arrow">→</span>
                <span className="automations-card__action">{tx("自动续跑", "Auto continuation")}</span>
              </div>
              <div className="automations-card__meta">
                {tx("运行实例", "Runs")}: {data.autoContinuationRunCount}
              </div>
              {activeAutoContinuationRuns.length > 0 ? (
                <div className="automations-card__active-runs">
                  {activeAutoContinuationRuns.map((run) => (
                    <button
                      className="knowledge-btn knowledge-btn--danger"
                      disabled={isPending}
                      key={run.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleStopAutoContinuation(run);
                      }}
                      type="button"
                    >
                      {isPending
                        ? tx("停止中...", "Stopping...")
                        : tx(`停止 ${run.agentId}`, `Stop ${run.agentId}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

              {data.rules.map((rule) => (
                <div
                  className={`automations-card${selectedId === rule.id ? " automations-card--selected" : ""}`}
                  key={rule.id}
                  onClick={() => setSelectedId(selectedId === rule.id ? null : rule.id)}
                >
                  <div className="automations-card__header">
                    <div className="automations-card__title">
                      <strong>{rule.name}</strong>
                      <span className={`automations-card__badge automations-card__badge--${rule.enabled ? "enabled" : "disabled"}`}>
                        {rule.enabled ? tx("启用", "Enabled") : tx("停用", "Paused")}
                      </span>
                    </div>
                    <div className="automations-card__actions">
                      <button
                        className="knowledge-btn knowledge-btn--ghost"
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggle(rule);
                        }}
                        type="button"
                      >
                        {rule.enabled ? tx("停用", "Pause") : tx("启用", "Enable")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--danger"
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(rule.id);
                        }}
                        type="button"
                      >
                        {tx("删除", "Delete")}
                      </button>
                    </div>
                  </div>
                  {rule.description ? (
                    <p className="automations-card__description">{rule.description}</p>
                  ) : null}
                  <div className="automations-card__flow">
                    <span className="automations-card__trigger">
                      {TRIGGER_TYPES.find((t) => t.value === rule.trigger.type)?.label ?? rule.trigger.type}
                    </span>
                    {rule.conditions.length > 0 ? (
                      <span className="automations-card__conditions">
                        → {rule.conditions.length} {tx("条件", "conditions")}
                      </span>
                    ) : null}
                    <span className="automations-card__arrow">→</span>
                    {rule.actions.map((action, i) => (
                      <span className="automations-card__action" key={i}>
                        {ACTION_TYPES.find((a) => a.value === action.type)?.label ?? action.type}
                      </span>
                    ))}
                  </div>
                  <div className="automations-card__meta">
                    {tx("执行次数", "Runs")}: {rule.runCount}
                    {rule.lastTriggeredAt
                      ? ` · ${tx("最近触发", "Last run")}: ${formatCompactTimestamp(rule.lastTriggeredAt, { emptyFallback: rule.lastTriggeredAt })}`
                      : ""}
                  </div>
                </div>
              ))}
          </>
        </div>

        {selectedBuiltinSequenceRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("然后", "Then")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条规则由群聊消息解析器触发。命中后会创建串行群文档协作流程，并按顺序调度相关 AI员工。", "This rule is triggered by the channel message parser. When matched, it creates a sequential channel-document workflow and dispatches AI employees in order.")}
            </p>
            <div className="automations-run-list">
              {data.documentRuns.length === 0 ? (
                <EmptyState
                  body={tx("还没有由这条规则触发的协作流程。", "No workflow runs have been triggered by this rule yet.")}
                  eyebrow={tx("运行实例", "Runs")}
                  title={tx("暂无运行记录", "No runs yet")}
                  variant="warm"
                />
              ) : (
                data.documentRuns.map((run) => {
                  const statusLabel = RUN_STATUS_LABELS[run.status];
                  return (
                    <div className="automations-run" key={run.id}>
                      <div className="automations-run__header">
                        <strong>{tx(`群聊协作 · ${run.channelName}`, `Chat collaboration · ${run.channelName}`)}</strong>
                        <span className={`automations-card__badge automations-card__badge--run-${run.status}`}>
                          {tx(statusLabel.label, statusLabel.labelEn)}
                        </span>
                      </div>
                      <p>{run.sourceSummary}</p>
                      <div className="automations-card__flow">
                        {run.steps.map((step, index) => (
                          <span className="automations-card__action" key={step.id}>
                            {index + 1}. {step.agentLabel}
                          </span>
                        ))}
                      </div>
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(run.updatedAt, { emptyFallback: run.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedBuiltinAutoContinuationRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{tx("做…直到", "Do until")}</h2>
              <span>{tx("内置规则", "Built-in rule")}</span>
            </div>
            <p>
              {tx("这条规则由群聊消息解析器触发。命中后会在当前会话执行空间里保持自动续跑状态，每轮任务完成后继续调度同一个 AI员工，直到截止时间。", "This rule is triggered by the channel message parser. It keeps an auto-continuation state in the conversation workspace and dispatches the same AI employee after each task until the deadline.")}
            </p>
            <div className="automations-run-list">
              {data.autoContinuationRuns.length === 0 ? (
                <EmptyState
                  body={tx("还没有由这条规则触发的自动续跑会话。", "No auto-continuation sessions have been triggered by this rule yet.")}
                  eyebrow={tx("运行实例", "Runs")}
                  title={tx("暂无运行记录", "No runs yet")}
                  variant="warm"
                />
              ) : (
                data.autoContinuationRuns.map((run) => {
                  const statusLabel = AUTO_CONTINUATION_STATUS_LABELS[run.status];
                  return (
                    <div className="automations-run" key={run.id}>
                      <div className="automations-run__header">
                        <strong>{tx(`自动续跑 · ${run.channelName} · ${run.agentId}`, `Auto continuation · ${run.channelName} · ${run.agentId}`)}</strong>
                        <div className="automations-run__header-actions">
                          <span className={`automations-card__badge automations-card__badge--run-${statusLabel.badge}`}>
                            {tx(statusLabel.label, statusLabel.labelEn)}
                          </span>
                          {run.status === "active" ? (
                            <button
                              className="knowledge-btn knowledge-btn--danger"
                              disabled={isPending}
                              onClick={() => handleStopAutoContinuation(run)}
                              type="button"
                            >
                              {isPending ? tx("停止中...", "Stopping...") : tx("停止", "Stop")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p>{run.instruction}</p>
                      <div className="automations-card__flow">
                        <span className="automations-card__action">{run.agentId}</span>
                        <span className="automations-card__conditions">
                          → {tx("迭代", "Iteration")} {run.iteration}
                        </span>
                        <span className="automations-card__conditions">
                          → {tx("队列", "Queue")}: {getQueueStatusLabel(run.lastTaskStatus, tx)}
                        </span>
                        <span className="automations-card__conditions">
                          → {tx("截止", "Until")}: {formatCompactTimestamp(run.until, { emptyFallback: run.until })}
                        </span>
                      </div>
                      <small>{tx("最近更新", "Updated")}: {formatCompactTimestamp(run.updatedAt, { emptyFallback: run.updatedAt })}</small>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        {selectedRule ? (
          <div className="automations-detail">
            <div className="automations-detail__header">
              <h2>{selectedRule.name}</h2>
              <span>{selectedRule.enabled ? tx("启用", "Enabled") : tx("停用", "Paused")}</span>
            </div>
            {selectedRule.description ? <p>{selectedRule.description}</p> : null}
            <div className="automations-card__flow">
              <span className="automations-card__trigger">
                {TRIGGER_TYPES.find((item) => item.value === selectedRule.trigger.type)?.label ?? selectedRule.trigger.type}
              </span>
              {selectedRule.conditions.map((condition) => (
                <span className="automations-card__conditions" key={`${condition.field}:${condition.operator}:${condition.value}`}>
                  → {getConditionFieldLabel(condition.field, tx)} {getConditionOperatorLabel(condition.operator, tx)} {condition.value}
                </span>
              ))}
              <span className="automations-card__arrow">→</span>
              {selectedRule.actions.map((action, index) => (
                <span className="automations-card__action" key={`${action.type}:${index}`}>
                  {ACTION_TYPES.find((item) => item.value === action.type)?.label ?? action.type}
                </span>
              ))}
            </div>
            <div className="automations-card__meta">
              {tx("执行次数", "Runs")}: {selectedRule.runCount}
              {selectedRule.lastTriggeredAt
                ? ` · ${tx("最近触发", "Last run")}: ${formatCompactTimestamp(selectedRule.lastTriggeredAt, { emptyFallback: selectedRule.lastTriggeredAt })}`
                : ""}
            </div>
          </div>
        ) : null}

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal knowledge-modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="automations-builder__header">
              <div>
                <span>{tx("自定义规则", "Custom rule")}</span>
                <h3>{tx("新建自动化规则", "New automation rule")}</h3>
              </div>
            </div>

            <div className="automations-builder__identity">
              <input
                autoFocus
                className="knowledge-modal__input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={tx("给这条规则起个名字", "Name this rule")}
              />
              <input
                className="knowledge-modal__input"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder={tx("备注，例如：客户投诉自动通知", "Note, for example: notify on customer complaints")}
              />
            </div>

            <div className="automations-builder">
              <div className="automations-builder__step">
                <span className="automations-builder__step-index">1</span>
                <div className="automations-builder__step-body">
                  <label>{tx("当发生", "When")}</label>
                  <select
                    className="tables-create__col-type"
                    value={createTriggerType}
                    onChange={(e) => setCreateTriggerType(e.target.value as AutomationTriggerType)}
                  >
                    {TRIGGER_TYPES.map((trigger) => (
                      <option key={trigger.value} value={trigger.value}>
                        {tx(trigger.label, trigger.labelEn)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="automations-builder__step">
                <span className="automations-builder__step-index">2</span>
                <div className="automations-builder__step-body">
                  <label>{tx("如果满足", "If")}</label>
                  <div className="automations-builder__condition">
                    <select
                      className="tables-create__col-type"
                      value={createConditionField}
                      onChange={(e) => setCreateConditionField(e.target.value)}
                    >
                      {CONDITION_FIELDS.map((field) => (
                        <option key={field.value} value={field.value}>
                          {tx(field.label, field.labelEn)}
                        </option>
                      ))}
                    </select>
                    <select
                      className="tables-create__col-type"
                      value={createConditionOperator}
                      onChange={(e) => setCreateConditionOperator(e.target.value as AutomationConditionOperator)}
                    >
                      {CONDITION_OPERATORS.map((operator) => (
                        <option key={operator.value} value={operator.value}>
                          {tx(operator.label, operator.labelEn)}
                        </option>
                      ))}
                    </select>
                    <input
                      className="knowledge-modal__input"
                      value={createConditionValue}
                      onChange={(e) => setCreateConditionValue(e.target.value)}
                      placeholder={tx(selectedConditionField.placeholder, selectedConditionField.placeholderEn)}
                    />
                  </div>
                </div>
              </div>

              <div className="automations-builder__step">
                <span className="automations-builder__step-index">3</span>
                <div className="automations-builder__step-body">
                  <label>{tx("就执行", "Then")}</label>
                  <select
                    className="tables-create__col-type"
                    value={createActionType}
                    onChange={(e) => setCreateActionType(e.target.value as AutomationActionType)}
                  >
                    {ACTION_TYPES.map((action) => (
                      <option key={action.value} value={action.value}>
                        {tx(action.label, action.labelEn)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="automations-builder__preview">
              <span>{tx("规则预览", "Preview")}</span>
              <strong>
                {tx("当", "When")} {tx(selectedTriggerLabel?.label ?? createTriggerType, selectedTriggerLabel?.labelEn ?? createTriggerType)}
                {createConditionValue.trim()
                  ? `，${tx("且", "and")} ${tx(selectedConditionField.label, selectedConditionField.labelEn)} ${tx(selectedOperatorLabel?.label ?? createConditionOperator, selectedOperatorLabel?.labelEn ?? createConditionOperator)} “${createConditionValue.trim()}”`
                  : `，${tx("无额外条件", "with no extra condition")}`}
                ，{tx("执行", "run")} {tx(selectedActionLabel?.label ?? createActionType, selectedActionLabel?.labelEn ?? createActionType)}
              </strong>
            </div>

            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createName.trim()}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}
