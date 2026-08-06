"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import type { WorkflowPublishValidation } from "@dofe-agent/services";
import { translateWorkflowErrorCode } from "@/features/i18n/presentation";
import {
  createWorkflowDraftAction,
  publishWorkflowAction,
  updateWorkflowDraftAction,
  validateWorkflowAction,
} from "./workflow-actions";
import {
  createWorkflowDraftState,
  workflowDraftReducer,
  type WorkflowDraftEvent,
} from "./workflow-builder-reducer";
import { validateWorkflowDraft } from "./workflow-client-validation";
import { WorkflowCanvas } from "./workflow-canvas";
import { WorkflowPreflightPanel, workflowPreflightBlockerLabel } from "./workflow-preflight-panel";
import type {
  WorkflowBuilderEmployee,
  WorkflowBuilderEntry,
  WorkflowBuilderInitialValue,
} from "./workflow-types";

const STEPS = ["目标", "触发", "流程", "治理", "预览"] as const;

type TriggerType = "manual" | "schedule" | "event";

export function WorkflowBuilderClient({
  workspaceSlug,
  entry,
  employees,
  initial,
}: {
  workspaceSlug: string;
  entry: WorkflowBuilderEntry;
  employees: WorkflowBuilderEmployee[];
  initial?: WorkflowBuilderInitialValue;
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState(initial?.id);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [savedMetadata, setSavedMetadata] = useState({ name: initial?.name ?? "", description: initial?.description ?? "" });
  const [draft, dispatch] = useReducer(
    workflowDraftReducer,
    undefined,
    () => createWorkflowDraftState(initial?.graph ?? emptyGraph(), initial?.draftVersion ?? 0),
  );
  const [activeStep, setActiveStep] = useState(entry === "calendar" ? 1 : 0);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [triggerType, setTriggerType] = useState<TriggerType>(initial?.trigger.type ?? (entry === "calendar" ? "schedule" : "manual"));
  const [schedule, setSchedule] = useState(stringConfig(initial?.trigger.config.cron, "0 9 * * 1-5"));
  const [eventName, setEventName] = useState(stringConfig(initial?.trigger.config.eventName, ""));
  const [timezone, setTimezone] = useState(initial?.trigger.timezone ?? "Asia/Shanghai");
  const [maxConcurrency, setMaxConcurrency] = useState(initial?.governance.maxConcurrency ?? 4);
  const [failurePolicy, setFailurePolicy] = useState<"stop" | "continue">(initial?.governance.failurePolicy ?? "stop");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [validation, setValidation] = useState<WorkflowPublishValidation | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "preflight" | "publish" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [parallelSource, setParallelSource] = useState("");
  const [parallelEmployeeA, setParallelEmployeeA] = useState("");
  const [parallelEmployeeB, setParallelEmployeeB] = useState("");

  const graph = useMemo<WorkflowGraphDefinition>(
    () => ({ schemaVersion: 1, nodes: draft.nodes, edges: draft.edges }),
    [draft.edges, draft.nodes],
  );
  const metadataDirty = name !== savedMetadata.name || description !== savedMetadata.description;
  const draftDirty = draft.dirty || metadataDirty;
  const isDirty = draftDirty || configurationDirty;
  const errorNodeIds = validation?.blockers.flatMap((blocker) => blocker.nodeId ? [blocker.nodeId] : []) ?? [];
  const clientErrors = validateWorkflowDraft(graph).errors;
  const canPublish = Boolean(workflowId && validation && validation.blockers.length === 0 && !draftDirty);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  function invalidatePreflight(): void {
    setValidation(null);
    setNotice(null);
  }

  function updateDraftMetadata(update: () => void): void {
    update();
    invalidatePreflight();
  }

  function updateConfiguration(update: () => void): void {
    update();
    setConfigurationDirty(true);
    invalidatePreflight();
  }

  function handleDraftEvent(event: WorkflowDraftEvent): void {
    dispatch(event);
    invalidatePreflight();
  }

  async function saveDraft(): Promise<{ workflowId: string; draftVersion: number; graph: WorkflowGraphDefinition } | null> {
    if (!name.trim()) {
      setActiveStep(0);
      setNotice({ tone: "error", message: "请先填写工作流名称。" });
      return null;
    }
    setPendingAction("save");
    let saved: { workflowId: string; draftVersion: number; graph: WorkflowGraphDefinition };
    if (workflowId) {
      const result = await updateWorkflowDraftAction({
          workflowId,
          expectedDraftVersion: draft.draftVersion,
          patch: { name, description, graph },
        });
      setPendingAction(null);
      if (!result.ok) {
        setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
        return null;
      }
      saved = { workflowId, draftVersion: result.data.draftVersion, graph: result.data.graph };
    } else {
      const result = await createWorkflowDraftAction({ name, description, graph });
      setPendingAction(null);
      if (!result.ok) {
        setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
        return null;
      }
      saved = result.data;
    }
    setWorkflowId(saved.workflowId);
    dispatch({ type: "markSaved", canonical: saved.graph, draftVersion: saved.draftVersion });
    setSavedMetadata({ name, description });
    setValidation(null);
    setNotice({ tone: "success", message: "草稿已保存。" });
    if (!workflowId) router.replace(`/w/${encodeURIComponent(workspaceSlug)}/automations/${encodeURIComponent(saved.workflowId)}`);
    return saved;
  }

  async function runPreflight(): Promise<void> {
    const saved = draftDirty || !workflowId
      ? await saveDraft()
      : { workflowId, draftVersion: draft.draftVersion, graph };
    if (!saved) return;
    setPendingAction("preflight");
    const result = await validateWorkflowAction({
      workflowId: saved.workflowId,
      graph: saved.graph,
      governance: { maxConcurrency, failurePolicy },
    });
    setPendingAction(null);
    if (!result.ok) {
      setValidation(null);
      setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
      if (result.error.nodeId) focusNode(result.error.nodeId);
      return;
    }
    setValidation(result.data);
    setNotice(result.data.blockers.length > 0
      ? { tone: "error", message: workflowPreflightBlockerLabel(result.data.blockers[0]!.code) }
      : { tone: "success", message: "预检通过，可以发布。" });
    const firstBlockedNode = result.data.blockers.find((blocker) => blocker.nodeId)?.nodeId;
    if (firstBlockedNode) focusNode(firstBlockedNode);
  }

  async function publish(): Promise<void> {
    if (!workflowId || !canPublish) return;
    setPendingAction("publish");
    const result = await publishWorkflowAction({
      workflowId,
      expectedDraftVersion: draft.draftVersion,
      graph,
      governance: { maxConcurrency, failurePolicy },
      trigger: triggerPayload(triggerType, schedule, eventName, timezone),
    });
    setPendingAction(null);
    if (!result.ok) {
      setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
      if (result.error.nodeId) focusNode(result.error.nodeId);
      return;
    }
    setNotice({ tone: "success", message: "工作流已发布。" });
    setConfigurationDirty(false);
    router.refresh();
  }

  function focusNode(nodeId: string): void {
    setSelectedNodeId(nodeId);
    setActiveStep(2);
  }

  function addParallelGroup(): void {
    if (!parallelSource || !parallelEmployeeA || !parallelEmployeeB) return;
    const ordinal = draft.nodes.length + 1;
    handleDraftEvent({
      type: "addParallelGroup",
      sourceNodeId: parallelSource,
      branches: [
        { id: `parallel-${ordinal}-a`, employeeId: parallelEmployeeA },
        { id: `parallel-${ordinal}-b`, employeeId: parallelEmployeeB },
      ],
      joinId: `join-${ordinal}`,
    });
    setParallelEmployeeA("");
    setParallelEmployeeB("");
  }

  return (
    <main className="workflow-wizard">
      <header className="workflow-wizard__header">
        <div>
          <span>编排中心 / {initial ? "编辑计划" : "新建计划"}</span>
          <h1>{name.trim() || "未命名工作流"}</h1>
          <p>将串行步骤、并行分支和汇总员工组织为可发布的执行计划。</p>
        </div>
        <div className="workflow-wizard__header-actions">
          <span className="workflow-wizard__save-state">{draftDirty ? "有未保存修改" : configurationDirty ? "有待发布配置" : "草稿已同步"}</span>
          <button className="knowledge-btn" disabled={pendingAction !== null || !draftDirty} onClick={() => void saveDraft()} type="button">
            {pendingAction === "save" ? "保存中" : "保存草稿"}
          </button>
        </div>
      </header>

      <nav aria-label="创建步骤" className="workflow-wizard__steps">
        {STEPS.map((step, index) => (
          <button aria-current={activeStep === index ? "step" : undefined} key={step} onClick={() => setActiveStep(index)} type="button">
            <span>{index + 1}</span>{step}
          </button>
        ))}
      </nav>

      {notice ? <p className={`workflow-wizard__notice workflow-wizard__notice--${notice.tone}`} role="status">{notice.message}</p> : null}

      <section aria-labelledby="workflow-step-title" className="workflow-wizard__content">
        <h2 id="workflow-step-title">{STEPS[activeStep]}</h2>
        {activeStep === 0 ? (
          <div className="workflow-wizard__form">
            <label><span>工作流名称</span><input autoFocus onChange={(event) => updateDraftMetadata(() => setName(event.target.value))} value={name} /></label>
            <label><span>目标与交付说明</span><textarea onChange={(event) => updateDraftMetadata(() => setDescription(event.target.value))} rows={7} value={description} /></label>
          </div>
        ) : null}
        {activeStep === 1 ? (
          <div className="workflow-wizard__form">
            <fieldset>
              <legend>触发方式</legend>
              <div className="workflow-wizard__choice-grid">
                {(["manual", "schedule", "event"] as const).map((type) => (
                  <label key={type}><input checked={triggerType === type} name="trigger" onChange={() => updateConfiguration(() => setTriggerType(type))} type="radio" />{triggerLabel(type)}</label>
                ))}
              </div>
            </fieldset>
            {triggerType === "schedule" ? <><label><span>Cron 表达式</span><input onChange={(event) => updateConfiguration(() => setSchedule(event.target.value))} value={schedule} /></label><label><span>时区</span><input onChange={(event) => updateConfiguration(() => setTimezone(event.target.value))} value={timezone} /></label></> : null}
            {triggerType === "event" ? <label><span>事件名称</span><input onChange={(event) => updateConfiguration(() => setEventName(event.target.value))} value={eventName} /></label> : null}
          </div>
        ) : null}
        {activeStep === 2 ? (
          <div className="workflow-wizard__flow">
            <div className="workflow-parallel-control">
              <strong>添加并行汇聚</strong>
              <select aria-label="并行起点" onChange={(event) => setParallelSource(event.target.value)} value={parallelSource}><option value="">选择起点步骤</option>{draft.nodes.filter((node) => node.type === "employee_task").map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select>
              <select aria-label="并行员工 A" onChange={(event) => setParallelEmployeeA(event.target.value)} value={parallelEmployeeA}><EmployeeOptions employees={employees} /></select>
              <select aria-label="并行员工 B" onChange={(event) => setParallelEmployeeB(event.target.value)} value={parallelEmployeeB}><EmployeeOptions employees={employees} /></select>
              <button className="knowledge-btn" disabled={!parallelSource || !parallelEmployeeA || !parallelEmployeeB} onClick={addParallelGroup} type="button">添加并行分支</button>
            </div>
            {clientErrors.length > 0 ? <p className="workflow-wizard__hint">当前结构有 {clientErrors.length} 项待完善，发布预检会定位具体步骤。</p> : null}
            <WorkflowCanvas employees={employees} errorNodeIds={errorNodeIds} graph={graph} onEvent={handleDraftEvent} onSelectNode={setSelectedNodeId} selectedNodeId={selectedNodeId} />
          </div>
        ) : null}
        {activeStep === 3 ? (
          <div className="workflow-wizard__form">
            <label><span>最大并发数</span><input max={20} min={1} onChange={(event) => updateConfiguration(() => setMaxConcurrency(Number(event.target.value)))} type="number" value={maxConcurrency} /></label>
            <fieldset><legend>失败策略</legend><div className="workflow-wizard__choice-grid"><label><input checked={failurePolicy === "stop"} name="failure-policy" onChange={() => updateConfiguration(() => setFailurePolicy("stop"))} type="radio" />停止后续步骤</label><label><input checked={failurePolicy === "continue"} name="failure-policy" onChange={() => updateConfiguration(() => setFailurePolicy("continue"))} type="radio" />允许部分结果</label></div></fieldset>
          </div>
        ) : null}
        {activeStep === 4 ? (
          <div className="workflow-wizard__preview">
            <dl><div><dt>名称</dt><dd>{name || "未填写"}</dd></div><div><dt>触发</dt><dd>{triggerLabel(triggerType)}</dd></div><div><dt>AI 员工步骤</dt><dd>{draft.nodes.filter((node) => node.type === "employee_task").length}</dd></div><div><dt>并行汇聚</dt><dd>{draft.nodes.filter((node) => node.type === "join").length}</dd></div></dl>
            <WorkflowPreflightPanel isPending={pendingAction === "preflight"} onFocusNode={focusNode} onRun={() => void runPreflight()} validation={validation} />
          </div>
        ) : null}
      </section>

      <footer className="workflow-wizard__footer">
        <button className="knowledge-btn" disabled={activeStep === 0} onClick={() => setActiveStep((current) => Math.max(0, current - 1))} type="button">上一步</button>
        <span>{activeStep + 1} / {STEPS.length}</span>
        <div className="workflow-wizard__footer-actions">
          {activeStep < STEPS.length - 1 ? <button className="knowledge-btn" onClick={() => setActiveStep((current) => Math.min(STEPS.length - 1, current + 1))} type="button">下一步</button> : null}
          <button className="knowledge-btn knowledge-btn--primary" disabled={!canPublish || pendingAction !== null} onClick={() => void publish()} type="button">{pendingAction === "publish" ? "发布中" : "发布"}</button>
        </div>
      </footer>
    </main>
  );
}

function EmployeeOptions({ employees }: { employees: WorkflowBuilderEmployee[] }) {
  return <><option value="">选择 AI 员工</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.status !== "online" ? "（未就绪）" : ""}</option>)}</>;
}

function emptyGraph(): WorkflowGraphDefinition {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

function triggerLabel(type: TriggerType): string {
  return type === "manual" ? "手动触发" : type === "schedule" ? "定时触发" : "事件触发";
}

function triggerPayload(type: TriggerType, schedule: string, eventName: string, timezone: string) {
  if (type === "schedule") return { type, config: { cron: schedule }, timezone };
  if (type === "event") return { type, config: { eventName } };
  return { type, config: {} };
}

function stringConfig(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
