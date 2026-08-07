import { useEffect, useState } from "react";
import type { WorkflowGraphDefinition, WorkflowNodeDefinition } from "@dofe-agent/domain";
import type { WorkflowDraftEvent } from "./workflow-builder-reducer";
import { workflowNodeLabel, type WorkflowEmployeeOption } from "./workflow-node-list-view";

export function WorkflowNodeConfigPanel({
  node,
  graph,
  employees,
  members,
  onEvent,
}: {
  node: WorkflowNodeDefinition;
  graph: WorkflowGraphDefinition;
  employees: WorkflowEmployeeOption[];
  members?: Array<{ userId: string; displayName: string }>;
  onEvent: (event: WorkflowDraftEvent) => void;
}) {
  const targets = graph.nodes.filter((candidate) => candidate.id !== node.id);
  const retry = typeof node.config.retry === "object" && node.config.retry
    ? node.config.retry as { maxAttempts?: number }
    : {};
  return (
    <aside aria-label="步骤配置" className="workflow-node-config">
      <header>
        <div>
          <span>{node.type}</span>
          <h2 title={workflowNodeLabel(node, employees)}>{workflowNodeLabel(node, employees)}</h2>
        </div>
        <button aria-label="删除步骤" className="knowledge-btn knowledge-btn--danger" onClick={() => { if (window.confirm("确认从草稿中删除该步骤？")) onEvent({ type: "removeNode", nodeId: node.id }); }} type="button">删除</button>
      </header>
      {node.type === "employee_task" ? (
        <>
          <label>
            <span>AI 员工</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { employeeId: event.target.value } })}
              value={node.employeeId ?? ""}
            >
              <option value="">选择员工</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>
            <span>任务说明</span>
            <textarea
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, instruction: event.target.value } } })}
              rows={5}
              value={typeof node.config.instruction === "string" ? node.config.instruction : ""}
            />
          </label>
          <label>
            <span>协作频道</span>
            <input
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, channelName: event.target.value } } })}
              value={typeof node.config.channelName === "string" ? node.config.channelName : ""}
            />
          </label>
          <CommaSeparatedField key={`${node.id}:skills`} node={node} onEvent={onEvent} />
          <OutputFieldsField key={`${node.id}:outputs`} node={node} onEvent={onEvent} />
          <WorkflowInputEditor key={node.id} node={node} onEvent={onEvent} />
          <div className="workflow-node-config__numbers">
            <OptionalNumberField label="单步预算上限（USD）" node={node} onEvent={onEvent} property="budgetUsd" />
            <OptionalNumberField label="预计成本（USD）" node={node} onEvent={onEvent} property="estimatedCostUsd" />
          </div>
          <label>
            <span>最大尝试次数</span>
            <input
              max={10}
              min={1}
              onChange={(event) => onEvent({
                type: "updateNode",
                nodeId: node.id,
                patch: { config: { ...node.config, retry: { ...retry, maxAttempts: Number(event.target.value) } } },
              })}
              type="number"
              value={retry.maxAttempts ?? 1}
            />
          </label>
        </>
      ) : null}
      {node.type === "join" ? (
        <label>
          <span>汇聚策略</span>
          <select
            onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, policy: event.target.value } } })}
            value={typeof node.config.policy === "string" ? node.config.policy : "all_success"}
          >
            <option value="all_success">全部成功后继续</option>
            <option value="allow_partial">允许部分结果</option>
          </select>
        </label>
      ) : null}
      {node.type === "approval" ? (
        <>
          <label>
            <span>提交审批的 AI 员工</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, employeeId: event.target.value } } })}
              value={typeof node.config.employeeId === "string" ? node.config.employeeId : ""}
            >
              <option value="">选择员工</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>
            <span>审批频道</span>
            <input
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, channelName: event.target.value } } })}
              value={typeof node.config.channelName === "string" ? node.config.channelName : ""}
            />
          </label>
          <label>
            <span>审批说明</span>
            <textarea
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, instruction: event.target.value } } })}
              rows={4}
              value={typeof node.config.instruction === "string" ? node.config.instruction : ""}
            />
          </label>
          <label>
            <span>风险等级</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, risk: event.target.value || undefined } } })}
              value={typeof node.config.risk === "string" ? node.config.risk : ""}
            >
              <option value="">不指定</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
          <label>
            <span>指定审批人</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, reviewerUserId: event.target.value || undefined } } })}
              value={typeof node.config.reviewerUserId === "string" ? node.config.reviewerUserId : ""}
            >
              <option value="">默认（管理员/负责人）</option>
              {(members ?? []).map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>审批限时（秒，留空表示不限时）</span>
            <input
              max={2592000}
              min={1}
              onChange={(event) => onEvent({
                type: "updateNode",
                nodeId: node.id,
                patch: { config: { ...node.config, deadlineSeconds: event.target.value ? Number(event.target.value) : undefined } },
              })}
              placeholder="例如 3600 表示 1 小时"
              type="number"
              value={typeof node.config.deadlineSeconds === "number" ? node.config.deadlineSeconds : ""}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>连接到</span>
        <select
          aria-label="连接到"
          onChange={(event) => {
            if (event.target.value) onEvent({ type: "connect", source: node.id, target: event.target.value });
            event.target.value = "";
          }}
          value=""
        >
          <option value="">选择下游步骤</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{workflowNodeLabel(target, employees)}</option>)}
        </select>
      </label>
    </aside>
  );
}

function WorkflowInputEditor({
  node,
  onEvent,
}: {
  node: WorkflowNodeDefinition;
  onEvent: (event: WorkflowDraftEvent) => void;
}) {
  const serialized = JSON.stringify(isRecord(node.config.input) ? node.config.input : {}, null, 2);
  const [value, setValue] = useState(serialized);
  const [error, setError] = useState("");
  useEffect(() => setValue(serialized), [serialized]);

  function applyValue(): void {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!isRecord(parsed)) throw new Error("input_must_be_object");
      setError("");
      onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, input: parsed } } });
    } catch {
      setError("请输入有效的 JSON 对象。");
    }
  }

  return (
    <label>
      <span>输入映射（JSON）</span>
      <textarea
        aria-invalid={Boolean(error)}
        onBlur={applyValue}
        onChange={(event) => setValue(event.target.value)}
        rows={6}
        value={value}
      />
      {error ? <small className="workflow-node-config__error" role="alert">{error}</small> : null}
    </label>
  );
}

function OptionalNumberField({
  label,
  node,
  onEvent,
  property,
}: {
  label: string;
  node: WorkflowNodeDefinition;
  onEvent: (event: WorkflowDraftEvent) => void;
  property: "budgetUsd" | "estimatedCostUsd";
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        min="0.01"
        onChange={(event) => {
          const config = { ...node.config };
          if (event.target.value) config[property] = Number(event.target.value);
          else delete config[property];
          onEvent({ type: "updateNode", nodeId: node.id, patch: { config } });
        }}
        step="0.01"
        type="number"
        value={typeof node.config[property] === "number" ? node.config[property] : ""}
      />
    </label>
  );
}

function CommaSeparatedField({
  node,
  onEvent,
}: {
  node: WorkflowNodeDefinition;
  onEvent: (event: WorkflowDraftEvent) => void;
}) {
  const serialized = Array.isArray(node.config.requiredSkillIds) ? node.config.requiredSkillIds.join(", ") : "";
  const [value, setValue] = useState(serialized);
  useEffect(() => setValue(serialized), [serialized]);
  return (
    <label>
      <span>所需技能 ID</span>
      <input
        onBlur={() => onEvent({
          type: "updateNode",
          nodeId: node.id,
          patch: { config: { ...node.config, requiredSkillIds: commaSeparatedValues(value) } },
        })}
        onChange={(event) => setValue(event.target.value)}
        placeholder="web-search, analysis"
        value={value}
      />
    </label>
  );
}

function OutputFieldsField({
  node,
  onEvent,
}: {
  node: WorkflowNodeDefinition;
  onEvent: (event: WorkflowDraftEvent) => void;
}) {
  const serialized = Array.isArray(node.config.outputFields) ? node.config.outputFields.join(", ") : "text";
  const [value, setValue] = useState(serialized);
  useEffect(() => setValue(serialized), [serialized]);
  return (
    <label>
      <span>输出字段</span>
      <input
        onBlur={() => onEvent({
          type: "updateNode",
          nodeId: node.id,
          patch: { config: { ...node.config, outputFields: commaSeparatedValues(value) } },
        })}
        onChange={(event) => setValue(event.target.value)}
        placeholder="text, report"
        value={value}
      />
    </label>
  );
}

function commaSeparatedValues(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
