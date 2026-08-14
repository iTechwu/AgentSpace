// 知识页 AI 员工分配面板与草稿控件：原 knowledge-page-client.tsx 文件内堆叠子组件，
// 抽出便于单元测试与代码导航；父级 KnowledgePageClient 仍持有 KnowledgeAssignmentPanel
// 与两处模态框（创建/从文档生成）共享 KnowledgeAssignmentDraftControls。
"use client";

import { useEffect, useState } from "react";
import type { KnowledgeAssignmentMode, KnowledgePage } from "@dofe-agent/domain/workspace";
import type { KnowledgePageData, KnowledgePageRecord } from "@/features/dashboard/data";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";

export function KnowledgeAssignmentPanel({
  agents,
  page,
  pending,
  onSave,
}: {
  agents: KnowledgePageData["agentOptions"];
  page: KnowledgePageRecord;
  pending: boolean;
  onSave: (assignmentMode: KnowledgeAssignmentMode, assignedEmployeeNames: string[]) => void;
}) {
  const { tx } = useLanguage();
  const [mode, setMode] = useState<KnowledgeAssignmentMode>(page.assignmentMode ?? "all_agents");
  const [selectedEmployeeNames, setSelectedEmployeeNames] = useState<string[]>(page.assignedEmployeeNames ?? []);

  useEffect(() => {
    setMode(page.assignmentMode ?? "all_agents");
    setSelectedEmployeeNames(page.assignedEmployeeNames ?? []);
  }, [page.id, page.assignmentMode, page.assignedEmployeeNames]);

  return (
    <section className="knowledge-assignment-card">
      <div className="knowledge-assignment-card__header">
        <div className="knowledge-assignment-card__title">
          <span className="knowledge-assignment-card__icon">
            <AppIcon name="agents" />
          </span>
          <div>
            <strong>{tx("AI员工 分配", "AI employee assignment")}</strong>
            <span>
              {mode === "all_agents"
                ? tx(`${agents.length} 个 AI员工 可用`, `${agents.length} AI employees can use this`)
                : tx(`${selectedEmployeeNames.length} 个 AI员工 已选择`, `${selectedEmployeeNames.length} selected AI employees`)}
            </span>
          </div>
        </div>
        <button
          className="knowledge-btn knowledge-btn--primary"
          disabled={pending}
          onClick={() => onSave(mode, selectedEmployeeNames)}
          type="button"
        >
          <AppIcon name="checkCircle" />
          {tx("保存分配", "Save assignment")}
        </button>
      </div>
      <KnowledgeAssignmentDraftControls
        agents={agents}
        mode={mode}
        selectedEmployeeNames={selectedEmployeeNames}
        onModeChange={setMode}
        onToggleEmployee={(employeeName) => {
          setSelectedEmployeeNames((current) => toggleEmployeeSelection(current, employeeName));
        }}
      />
    </section>
  );
}

export function KnowledgeAssignmentDraftControls({
  agents,
  mode,
  selectedEmployeeNames,
  onModeChange,
  onToggleEmployee,
}: {
  agents: KnowledgePageData["agentOptions"];
  mode: KnowledgeAssignmentMode;
  selectedEmployeeNames: string[];
  onModeChange: (mode: KnowledgeAssignmentMode) => void;
  onToggleEmployee: (employeeName: string) => void;
}) {
  const { tx } = useLanguage();

  return (
    <>
      <div className="knowledge-assignment-card__mode-grid">
        <label className={mode === "all_agents" ? "knowledge-assignment-option knowledge-assignment-option--active" : "knowledge-assignment-option"}>
          <input
            aria-label={tx("全员共享", "Shared with all agents")}
            checked={mode === "all_agents"}
            className="knowledge-assignment-option__input"
            onChange={() => onModeChange("all_agents")}
            type="radio"
          />
          <span className="knowledge-assignment-option__marker">
            <AppIcon name={mode === "all_agents" ? "checkCircle" : "knowledge"} />
          </span>
          <span className="knowledge-assignment-option__copy">
            <strong>{tx("全员共享", "Shared with all agents")}</strong>
            <small>{tx("所有 AI员工 自动继承这篇知识", "Every AI employee inherits this page")}</small>
          </span>
        </label>
        <label className={mode === "selected_agents" ? "knowledge-assignment-option knowledge-assignment-option--active" : "knowledge-assignment-option"}>
          <input
            aria-label={tx("指定 AI员工", "Selected AI employees")}
            checked={mode === "selected_agents"}
            className="knowledge-assignment-option__input"
            onChange={() => onModeChange("selected_agents")}
            type="radio"
          />
          <span className="knowledge-assignment-option__marker">
            <AppIcon name={mode === "selected_agents" ? "checkCircle" : "agents"} />
          </span>
          <span className="knowledge-assignment-option__copy">
            <strong>{tx("指定 AI员工", "Selected AI employees")}</strong>
            <small>{tx("只加入选中 AI员工 的知识范围", "Only selected AI employees can use it")}</small>
          </span>
        </label>
      </div>
      {mode === "selected_agents" ? (
        <div className="knowledge-assignment-card__agents">
          {agents.length > 0 ? (
            agents.map((agent) => (
              <label className="knowledge-agent-chip" key={agent.employeeName}>
                <input
                  checked={selectedEmployeeNames.includes(agent.employeeName)}
                  className="knowledge-agent-chip__input"
                  onChange={() => onToggleEmployee(agent.employeeName)}
                  type="checkbox"
                />
                <span className="knowledge-agent-chip__mark" />
                <span>{agent.name}</span>
              </label>
            ))
          ) : (
            <div className="knowledge-assignment-card__note">
              {tx("当前没有可分配 AI员工。", "No AI employees are available for assignment.")}
            </div>
          )}
        </div>
      ) : (
        <div className="knowledge-assignment-card__note">
          {tx("这篇知识会进入所有 AI员工 的默认知识范围。", "This page is included in every AI employee's default knowledge scope.")}
        </div>
      )}
    </>
  );
}

export function toggleEmployeeSelection(current: string[], employeeName: string): string[] {
  return current.includes(employeeName)
    ? current.filter((name) => name !== employeeName)
    : [...current, employeeName];
}