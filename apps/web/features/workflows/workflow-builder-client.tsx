"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKFLOW_EVENT_NAMES, type WorkflowGraphDefinition } from "@dofe-agent/domain";
import type { WorkflowPublishValidation } from "@dofe-agent/services";
import { translateWorkflowErrorCode } from "@/features/i18n/presentation";
import {
  createWorkflowDraftAction,
  controlWorkflowDefinitionAction,
  publishWorkflowAction,
  runWorkflowAction,
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

type TriggerType = "manual" | "schedule" | "event" | "none";
type ScheduleMode = "once" | "daily" | "cron";
type MisfirePolicy = "skip" | "fire_once";
type NotificationMode = "in_app" | "channel";

export function WorkflowBuilderClient({
  workspaceSlug,
  entry,
  employees,
  channels,
  members,
  ownerLabel,
  initial,
}: {
  workspaceSlug: string;
  entry: WorkflowBuilderEntry;
  employees: WorkflowBuilderEmployee[];
  channels: string[];
  members: Array<{ userId: string; displayName: string }>;
  ownerLabel: string;
  initial?: WorkflowBuilderInitialValue;
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState(initial?.id);
  const [definitionStatus, setDefinitionStatus] = useState(initial?.status ?? "draft");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [channelName, setChannelName] = useState(initial?.channelName ?? "");
  const [notificationMode, setNotificationMode] = useState<NotificationMode>(initial?.channelName ? "channel" : "in_app");
  const [savedMetadata, setSavedMetadata] = useState({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    channelName: initial?.channelName ?? "",
    notificationMode: initial?.channelName ? "channel" as const : "in_app" as const,
  });
  const [draft, dispatch] = useReducer(
    workflowDraftReducer,
    undefined,
    () => createWorkflowDraftState(initial?.graph ?? emptyGraph(), initial?.draftVersion ?? 0),
  );
  const [activeStep, setActiveStep] = useState(entry === "calendar" ? 1 : 0);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [triggerType, setTriggerType] = useState<TriggerType>(
    initial?.trigger.type === "none"
      ? "manual"
      : initial?.trigger.type ?? (entry === "calendar" ? "schedule" : "manual"),
  );
  const [publishedTriggerType, setPublishedTriggerType] = useState<TriggerType | undefined>(
    initial?.status === "published" || initial?.status === "paused"
      ? (initial.trigger.type === "none" ? undefined : initial.trigger.type)
      : undefined,
  );
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(initialScheduleMode(initial?.trigger.config));
  const [schedule, setSchedule] = useState(stringConfig(initial?.trigger.config.cronExpression ?? initial?.trigger.config.cron, "0 9 * * 1-5"));
  const [onceAt, setOnceAt] = useState(stringConfig(initial?.trigger.config.onceAt, ""));
  const [dailyAt, setDailyAt] = useState(stringConfig(initial?.trigger.config.dailyAt, "09:00"));
  const [eventName, setEventName] = useState(stringConfig(initial?.trigger.config.eventName, ""));
  const [timezone, setTimezone] = useState(initial?.trigger.timezone ?? "Asia/Shanghai");
  const [misfirePolicy, setMisfirePolicy] = useState<MisfirePolicy>(initial?.trigger.misfirePolicy ?? "skip");
  const [maxConcurrency, setMaxConcurrency] = useState(initial?.governance.maxConcurrency ?? 4);
  const [budgetUsd, setBudgetUsd] = useState(initial?.governance.budgetUsd ? String(initial.governance.budgetUsd) : "");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [validation, setValidation] = useState<WorkflowPublishValidation | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "preflight" | "publish" | "pause" | "resume" | "run" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [parallelSource, setParallelSource] = useState("");
  const [parallelEmployeeA, setParallelEmployeeA] = useState("");
  const [parallelEmployeeB, setParallelEmployeeB] = useState("");

  const graph = useMemo<WorkflowGraphDefinition>(
    () => ({ schemaVersion: 1, nodes: draft.nodes, edges: draft.edges }),
    [draft.edges, draft.nodes],
  );
  const estimatedCostUsd = useMemo(() => draft.nodes.reduce((total, node) => {
    const estimate = node.config.estimatedCostUsd;
    if (!(typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0)) return total;
    const retry = typeof node.config.retry === "object" && node.config.retry
      ? node.config.retry as { maxAttempts?: number }
      : undefined;
    const maxAttempts = Number.isInteger(retry?.maxAttempts) && retry!.maxAttempts! >= 1 ? retry!.maxAttempts! : 1;
    return total + estimate * maxAttempts;
  }, 0), [draft.nodes]);
  const metadataDirty = name !== savedMetadata.name
    || description !== savedMetadata.description
    || channelName !== savedMetadata.channelName
    || notificationMode !== savedMetadata.notificationMode;
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
    if (notificationMode === "channel" && !channelName.trim()) {
      setActiveStep(0);
      setNotice({ tone: "error", message: "请选择通知频道。" });
      return null;
    }
    setPendingAction("save");
    let saved: { workflowId: string; draftVersion: number; graph: WorkflowGraphDefinition };
    if (workflowId) {
      const result = await updateWorkflowDraftAction({
          workflowId,
          expectedDraftVersion: draft.draftVersion,
          patch: { name, description, channelName: channelName.trim() || null, graph },
        });
      setPendingAction(null);
      if (!result.ok) {
        setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
        return null;
      }
      saved = { workflowId, draftVersion: result.data.draftVersion, graph: result.data.graph };
    } else {
      const result = await createWorkflowDraftAction({ name, description, channelName: channelName.trim() || undefined, graph });
      setPendingAction(null);
      if (!result.ok) {
        setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
        return null;
      }
      saved = result.data;
    }
    setWorkflowId(saved.workflowId);
    dispatch({ type: "markSaved", canonical: saved.graph, draftVersion: saved.draftVersion });
    setSavedMetadata({ name, description, channelName, notificationMode });
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
      governance: governancePayload(maxConcurrency, budgetUsd),
      trigger: triggerType === "none" ? undefined : triggerPayload(triggerType, scheduleMode, schedule, onceAt, dailyAt, eventName, timezone, misfirePolicy),
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
    // 发布会生成不可变的新版本并可能改变触发器与调度，属高影响操作，需二次确认（UIUX:136）。
    if (!window.confirm("确认发布该工作流？将生成不可变的新版本并立即生效。")) return;
    setPendingAction("publish");
    const result = await publishWorkflowAction({
      workflowId,
      expectedDraftVersion: draft.draftVersion,
      graph,
      governance: governancePayload(maxConcurrency, budgetUsd),
      trigger: triggerType === "none" ? undefined : triggerPayload(triggerType, scheduleMode, schedule, onceAt, dailyAt, eventName, timezone, misfirePolicy),
    });
    setPendingAction(null);
    if (!result.ok) {
      setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
      if (result.error.nodeId) focusNode(result.error.nodeId);
      return;
    }
    setNotice({ tone: "success", message: "工作流已发布。" });
    setDefinitionStatus(result.data.status === "paused" ? "paused" : "published");
    setPublishedTriggerType(triggerType);
    setConfigurationDirty(false);
    router.refresh();
  }

  async function controlDefinition(action: "pause" | "resume"): Promise<void> {
    if (!workflowId) return;
    setPendingAction(action);
    const result = await controlWorkflowDefinitionAction({ workflowId, action });
    setPendingAction(null);
    if (!result.ok) {
      setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
      return;
    }
    setDefinitionStatus(result.data.status === "paused" ? "paused" : "published");
    setNotice({ tone: "success", message: action === "pause" ? "工作流已暂停。" : "工作流已恢复。" });
    router.refresh();
  }

  async function runNow(): Promise<void> {
    if (!workflowId || definitionStatus !== "published" || publishedTriggerType !== "manual") return;
    setPendingAction("run");
    const result = await runWorkflowAction({
      workflowId,
      idempotencyKey: createManualRunKey(workflowId),
      input: {},
    });
    setPendingAction(null);
    if (!result.ok) {
      setNotice({ tone: "error", message: translateWorkflowErrorCode(result.error.code) });
      return;
    }
    router.push(`/w/${encodeURIComponent(workspaceSlug)}/automations/runs/${encodeURIComponent(result.data.runId)}`);
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
          {definitionStatus === "published" && publishedTriggerType === "manual" ? <button className="knowledge-btn knowledge-btn--primary" disabled={pendingAction !== null} onClick={() => void runNow()} type="button">{pendingAction === "run" ? "启动中" : "立即运行"}</button> : null}
          {definitionStatus === "published" ? <button className="knowledge-btn" disabled={pendingAction !== null} onClick={() => void controlDefinition("pause")} title="暂停新触发" type="button">{pendingAction === "pause" ? "暂停中" : "暂停"}</button> : null}
          {definitionStatus === "paused" ? <button className="knowledge-btn" disabled={pendingAction !== null} onClick={() => void controlDefinition("resume")} title="恢复未来触发" type="button">{pendingAction === "resume" ? "恢复中" : "恢复"}</button> : null}
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
            <label><span>负责人</span><input aria-label="负责人" readOnly value={ownerLabel} /></label>
            <label><span>通知方式</span><select aria-label="通知方式" onChange={(event) => updateDraftMetadata(() => {
              const mode = event.target.value as NotificationMode;
              setNotificationMode(mode);
              if (mode === "in_app") setChannelName("");
            })} value={notificationMode}><option value="in_app">仅站内状态</option><option disabled={channels.length === 0} value="channel">频道通知</option></select></label>
            {notificationMode === "channel" ? <label><span>通知频道</span><select aria-label="通知频道" onChange={(event) => updateDraftMetadata(() => setChannelName(event.target.value))} value={channelName}><option value="">选择通知频道</option>{channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}</select></label> : null}
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
            {triggerType === "schedule" ? <>
              <fieldset>
                <legend>执行周期</legend>
                <div className="workflow-wizard__choice-grid">
                  {(["once", "daily", "cron"] as const).map((mode) => (
                    <label key={mode}><input checked={scheduleMode === mode} name="schedule-mode" onChange={() => updateConfiguration(() => setScheduleMode(mode))} type="radio" />{scheduleModeLabel(mode)}</label>
                  ))}
                </div>
              </fieldset>
              {scheduleMode === "once" ? <label><span>执行时间（ISO 8601）</span><input onChange={(event) => updateConfiguration(() => setOnceAt(event.target.value))} placeholder="2026-08-08T11:00:00+08:00" value={onceAt} /></label> : null}
              {scheduleMode === "daily" ? <label><span>每天执行时间</span><input onChange={(event) => updateConfiguration(() => setDailyAt(event.target.value))} type="time" value={dailyAt} /></label> : null}
              {scheduleMode === "cron" ? <label><span>Cron 表达式</span><input onChange={(event) => updateConfiguration(() => setSchedule(event.target.value))} value={schedule} /></label> : null}
              <label><span>时区</span><input onChange={(event) => updateConfiguration(() => setTimezone(event.target.value))} value={timezone} /></label>
              <label><span>错过执行</span><select onChange={(event) => updateConfiguration(() => setMisfirePolicy(event.target.value as MisfirePolicy))} value={misfirePolicy}><option value="skip">跳过过期执行</option><option value="fire_once">仅补最近一次</option></select></label>
            </> : null}
            {triggerType === "event" ? <label><span>事件名称</span><select onChange={(event) => updateConfiguration(() => setEventName(event.target.value))} value={eventName}><option value="">选择事件</option>{WORKFLOW_EVENT_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</select></label> : null}
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
            <WorkflowCanvas employees={employees} errorNodeIds={errorNodeIds} graph={graph} members={members} onEvent={handleDraftEvent} onSelectNode={setSelectedNodeId} selectedNodeId={selectedNodeId} />
          </div>
        ) : null}
        {activeStep === 3 ? (
          <div className="workflow-wizard__form">
            <label><span>最大并发数</span><input max={20} min={1} onChange={(event) => updateConfiguration(() => setMaxConcurrency(Number(event.target.value)))} type="number" value={maxConcurrency} /></label>
            <label><span>流程预算上限（USD）</span><input min="0.01" onChange={(event) => updateConfiguration(() => setBudgetUsd(event.target.value))} placeholder="不限制" step="0.01" type="number" value={budgetUsd} /></label>
            <p className="workflow-wizard__hint">分支失败后的汇聚行为由流程中的 Join 节点策略决定。</p>
          </div>
        ) : null}
        {activeStep === 4 ? (
          <div className="workflow-wizard__preview">
            <dl><div><dt>名称</dt><dd>{name || "未填写"}</dd></div><div><dt>发布版本</dt><dd>{initial?.publishedVersionNumber ? `版本 ${initial.publishedVersionNumber}` : "尚未发布"}</dd></div><div><dt>草稿修订</dt><dd>{draft.draftVersion > 0 ? `修订 ${draft.draftVersion}` : "未保存"}</dd></div><div><dt>影响范围</dt><dd>当前工作区 {workspaceSlug}</dd></div><div><dt>负责人</dt><dd>{ownerLabel}</dd></div><div><dt>通知</dt><dd>{notificationMode === "channel" ? channelName ? `#${channelName}` : "未选择频道" : "仅站内状态"}</dd></div><div><dt>触发</dt><dd>{triggerLabel(triggerType)}</dd></div><div><dt>最大并发</dt><dd>{maxConcurrency}</dd></div><div><dt>预计成本</dt><dd>{estimatedCostUsd > 0 ? `$${estimatedCostUsd.toFixed(2)}` : "未设置预计成本"}</dd></div><div><dt>AI 员工步骤</dt><dd>{draft.nodes.filter((node) => node.type === "employee_task").length}</dd></div><div><dt>并行汇聚</dt><dd>{draft.nodes.filter((node) => node.type === "join").length}</dd></div></dl>
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

function governancePayload(
  maxConcurrency: number,
  budgetUsd: string,
): Record<string, unknown> {
  return {
    maxConcurrency,
    ...(budgetUsd ? { budgetUsd: Number(budgetUsd) } : {}),
  };
}

function createManualRunKey(workflowId: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual:${workflowId}:${nonce}`;
}

function EmployeeOptions({ employees }: { employees: WorkflowBuilderEmployee[] }) {
  return <><option value="">选择 AI 员工</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.status !== "online" ? "（未就绪）" : ""}</option>)}</>;
}

function emptyGraph(): WorkflowGraphDefinition {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

function triggerLabel(type: TriggerType): string {
  return type === "manual" ? "手动触发" : type === "schedule" ? "定时触发" : type === "event" ? "事件触发" : "未配置触发器";
}

function triggerPayload(type: Exclude<TriggerType, "none">, scheduleMode: ScheduleMode, schedule: string, onceAt: string, dailyAt: string, eventName: string, timezone: string, misfirePolicy: MisfirePolicy) {
  if (type === "schedule") {
    const config = scheduleMode === "once"
      ? { onceAt: onceAt.trim() }
      : scheduleMode === "daily"
        ? { dailyAt }
        : { cronExpression: schedule.trim() };
    return { type, config, timezone, misfirePolicy };
  }
  if (type === "event") return { type, config: { eventName } };
  return { type, config: {} };
}

function initialScheduleMode(config: Record<string, unknown> | undefined): ScheduleMode {
  if (typeof config?.onceAt === "string") return "once";
  if (typeof config?.dailyAt === "string") return "daily";
  return "cron";
}

function scheduleModeLabel(mode: ScheduleMode): string {
  return mode === "once" ? "一次性" : mode === "daily" ? "每天" : "Cron";
}

function stringConfig(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
