import type { MentionPlan } from "@dofe-agent/domain";
import type { ChannelDocumentRun, ChannelDocumentRunStep } from "@dofe-agent/domain";
import type {
  DofeAgentState,
} from "@dofe-agent/domain/workspace";

export function createChannelDocumentRun(input: {
  state: DofeAgentState;
  channelName: string;
  sourceMessageId: string;
  sourceSummary: string;
  plan: MentionPlan;
}): { state: DofeAgentState; run: ChannelDocumentRun; steps: ChannelDocumentRunStep[] } {
  const now = new Date().toISOString();
  const run: ChannelDocumentRun = {
    id: `channel-doc-run-${createOpaqueId()}`,
    channelName: input.channelName,
    sourceMessageId: input.sourceMessageId,
    sourceSummary: input.sourceSummary,
    mode: input.plan.mode,
    status: input.plan.mode === "parallel" ? "running" : "pending",
    createdAt: now,
    updatedAt: now,
  };
  const stepIdMap = new Map(input.plan.steps.map((step) => [step.id, `channel-doc-run-step-${createOpaqueId()}`]));
  const steps = input.plan.steps.map((step) => {
    const dependsOnStepIds = step.dependsOnStepIds
      .map((dependsOnStepId) => stepIdMap.get(dependsOnStepId))
      .filter((dependsOnStepId): dependsOnStepId is string => typeof dependsOnStepId === "string");

    return {
      id: stepIdMap.get(step.id)!,
      runId: run.id,
      agentId: step.agentId,
      agentLabel: step.agentLabel,
      instruction: step.instruction,
      dependsOnStepIds,
      handoffKind: step.handoffKind,
      status: (dependsOnStepIds.length > 0 ? "pending" : "ready") as ChannelDocumentRunStep["status"],
      createdAt: now,
      updatedAt: now,
    };
  }) satisfies ChannelDocumentRunStep[];

  input.state.channelDocumentRuns.unshift(run);
  input.state.channelDocumentRunSteps.unshift(...steps);

  return { state: input.state, run, steps };
}

export function listChannelDocumentRunSteps(
  state: DofeAgentState,
  runId: string,
): ChannelDocumentRunStep[] {
  return state.channelDocumentRunSteps
    .filter((step) => step.runId === runId)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

export function findChannelDocumentRunStepByQueuedTaskId(
  state: DofeAgentState,
  queuedTaskId: string,
): ChannelDocumentRunStep | null {
  return state.channelDocumentRunSteps.find((step) => step.queuedTaskId === queuedTaskId) ?? null;
}

export function listReadyChannelDocumentRunSteps(
  state: DofeAgentState,
  runId: string,
): ChannelDocumentRunStep[] {
  return listChannelDocumentRunSteps(state, runId).filter((step) => step.status === "ready");
}

export function markChannelDocumentRunStepQueued(
  state: DofeAgentState,
  stepId: string,
  queuedTaskId: string,
): ChannelDocumentRunStep {
  const step = requireChannelDocumentRunStep(state, stepId);
  step.status = "queued";
  step.queuedTaskId = queuedTaskId;
  step.updatedAt = new Date().toISOString();
  touchChannelDocumentRun(state, step.runId);
  return step;
}

export function markChannelDocumentRunStepRunning(
  state: DofeAgentState,
  stepId: string,
): ChannelDocumentRunStep {
  const step = requireChannelDocumentRunStep(state, stepId);
  step.status = "running";
  step.updatedAt = new Date().toISOString();
  const run = requireChannelDocumentRun(state, step.runId);
  run.status = "running";
  run.updatedAt = step.updatedAt;
  return step;
}

export function markChannelDocumentRunStepCompleted(
  state: DofeAgentState,
  input: {
    stepId: string;
    documentUpdates?: Array<{ documentId: string; documentVersionId: string }>;
    warningText?: string;
  },
): { step: ChannelDocumentRunStep; run: ChannelDocumentRun; readySteps: ChannelDocumentRunStep[] } {
  const step = requireChannelDocumentRunStep(state, input.stepId);
  step.status = input.warningText ? "completed_with_warning" : "completed";
  step.documentId = input.documentUpdates?.[0]?.documentId;
  step.documentVersionId = input.documentUpdates?.[0]?.documentVersionId;
  step.lastWarning = input.warningText?.trim() || undefined;
  step.updatedAt = new Date().toISOString();

  const run = requireChannelDocumentRun(state, step.runId);
  run.updatedAt = step.updatedAt;

  const steps = listChannelDocumentRunSteps(state, run.id);
  const readySteps: ChannelDocumentRunStep[] = [];
  for (const candidate of steps) {
    if (candidate.status !== "pending" && candidate.status !== "ready") {
      continue;
    }
    const allDepsCompleted = candidate.dependsOnStepIds.every((dependsOnStepId: string) =>
      steps.some(
        (dependency) =>
          dependency.id === dependsOnStepId &&
          (dependency.status === "completed" || dependency.status === "completed_with_warning"),
      ),
    );
    if (!allDepsCompleted) {
      continue;
    }
    candidate.status = "ready";
    candidate.updatedAt = step.updatedAt;
    readySteps.push(candidate);
  }

  if (steps.every((candidate) => candidate.status === "completed" || candidate.status === "completed_with_warning")) {
    run.status = steps.some((candidate) => candidate.status === "completed_with_warning")
      ? "completed_with_warning"
      : "completed";
  }

  return { step, run, readySteps };
}

export function markChannelDocumentRunStepFailed(
  state: DofeAgentState,
  stepId: string,
  errorText: string,
): { step: ChannelDocumentRunStep; run: ChannelDocumentRun } {
  const step = requireChannelDocumentRunStep(state, stepId);
  step.status = "failed";
  step.lastError = errorText;
  step.updatedAt = new Date().toISOString();

  const run = requireChannelDocumentRun(state, step.runId);
  run.status = "failed";
  run.updatedAt = step.updatedAt;

  return { step, run };
}

export function normalizeChannelDocumentRuns(
  runs: DofeAgentState["channelDocumentRuns"] | undefined,
  fallback: DofeAgentState["channelDocumentRuns"],
): DofeAgentState["channelDocumentRuns"] {
  if (!Array.isArray(runs)) {
    return fallback;
  }

  return runs
    .map((run) => normalizeChannelDocumentRun(run))
    .filter((run): run is ChannelDocumentRun => run !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function normalizeChannelDocumentRunSteps(
  steps: DofeAgentState["channelDocumentRunSteps"] | undefined,
  fallback: DofeAgentState["channelDocumentRunSteps"],
): DofeAgentState["channelDocumentRunSteps"] {
  if (!Array.isArray(steps)) {
    return fallback;
  }

  return steps
    .map((step) => normalizeChannelDocumentRunStep(step))
    .filter((step): step is ChannelDocumentRunStep => step !== null)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function normalizeChannelDocumentRun(run: unknown): ChannelDocumentRun | null {
  if (!run || typeof run !== "object") {
    return null;
  }

  const candidate = run as Partial<ChannelDocumentRun>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.channelName !== "string" ||
    typeof candidate.sourceMessageId !== "string" ||
    typeof candidate.sourceSummary !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    channelName: candidate.channelName,
    sourceMessageId: candidate.sourceMessageId,
    sourceSummary: candidate.sourceSummary,
    mode: candidate.mode === "sequential" ? "sequential" : "parallel",
    status:
      candidate.status === "running" ||
      candidate.status === "completed" ||
      candidate.status === "completed_with_warning" ||
      candidate.status === "failed"
        ? candidate.status
        : "pending",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeChannelDocumentRunStep(step: unknown): ChannelDocumentRunStep | null {
  if (!step || typeof step !== "object") {
    return null;
  }

  const candidate = step as Partial<ChannelDocumentRunStep>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.agentLabel !== "string" ||
    typeof candidate.instruction !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    runId: candidate.runId,
    agentId: candidate.agentId,
    agentLabel: candidate.agentLabel,
    instruction: candidate.instruction,
    dependsOnStepIds: Array.isArray(candidate.dependsOnStepIds)
      ? candidate.dependsOnStepIds.filter((value: unknown): value is string => typeof value === "string")
      : [],
    handoffKind:
      candidate.handoffKind === "document" || candidate.handoffKind === "attachment" ? candidate.handoffKind : "message",
    status:
      candidate.status === "ready" ||
      candidate.status === "queued" ||
      candidate.status === "running" ||
      candidate.status === "completed" ||
      candidate.status === "completed_with_warning" ||
      candidate.status === "failed" ||
      candidate.status === "blocked"
        ? candidate.status
        : "pending",
    queuedTaskId: typeof candidate.queuedTaskId === "string" ? candidate.queuedTaskId : undefined,
    documentId: typeof candidate.documentId === "string" ? candidate.documentId : undefined,
    documentVersionId: typeof candidate.documentVersionId === "string" ? candidate.documentVersionId : undefined,
    lastError: typeof candidate.lastError === "string" ? candidate.lastError : undefined,
    lastWarning: typeof candidate.lastWarning === "string" ? candidate.lastWarning : undefined,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function requireChannelDocumentRun(state: DofeAgentState, runId: string): ChannelDocumentRun {
  const run = state.channelDocumentRuns.find((item) => item.id === runId);
  if (!run) {
    throw new Error(`Channel document run "${runId}" does not exist.`);
  }
  return run;
}

function requireChannelDocumentRunStep(state: DofeAgentState, stepId: string): ChannelDocumentRunStep {
  const step = state.channelDocumentRunSteps.find((item) => item.id === stepId);
  if (!step) {
    throw new Error(`Channel document run step "${stepId}" does not exist.`);
  }
  return step;
}

function touchChannelDocumentRun(state: DofeAgentState, runId: string): void {
  const run = requireChannelDocumentRun(state, runId);
  run.updatedAt = new Date().toISOString();
}

function createOpaqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
