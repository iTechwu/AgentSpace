export const OPENMONTAGE_JOB_EVENT_TYPES = [
  "openmontage.job.created",
  "openmontage.stage.started",
  "openmontage.stage.progressed",
  "openmontage.stage.completed",
  "openmontage.job.waiting_approval",
  "openmontage.approval.resolved",
  "openmontage.usage.updated",
  "openmontage.artifact.published",
  "openmontage.job.completed",
  "openmontage.job.failed",
  "openmontage.job.cancel_requested",
  "openmontage.job.cancelled",
] as const;

export type OpenMontageJobEventType = (typeof OPENMONTAGE_JOB_EVENT_TYPES)[number];
export type OpenMontageJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED";
export type OpenMontageStageStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";
export type OpenMontageApprovalStatus =
  | "NOT_REQUIRED"
  | "REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED";

export interface OpenMontageJobEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: OpenMontageJobEventType;
  occurredAt: string;
  jobId: string;
  sequence: number;
  workspaceId: string;
  employeeId: string;
  runtimeId: string;
  rootTaskId: string;
  conversationId: string;
  sourceInvocationId: string;
  traceId: string;
  payload: Record<string, unknown>;
}

export interface OpenMontageStageProjection {
  code: string;
  labelCode: string;
  approvalRequired: boolean;
  approvalStatus: OpenMontageApprovalStatus;
  status: OpenMontageStageStatus;
  attempt: number;
  progress?: {
    completedUnits: number;
    totalUnits: number;
    labelCode: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface OpenMontageJobProjection {
  schemaVersion: 1;
  jobId: string;
  status: OpenMontageJobStatus;
  workflow: {
    name: string;
    version: string;
  };
  stages: OpenMontageStageProjection[];
  currentStage: string | null;
  usageSummary?: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
  error?: Record<string, unknown>;
  lastAppliedSequence: number;
  syncStatus: "CURRENT" | "SYNCING";
  nextExpectedSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenMontageJobSnapshotSeed {
  schemaVersion: 1;
  jobId: string;
  status: OpenMontageJobStatus;
  workflow: {
    name: string;
    version: string;
    stages: Array<{
      code: string;
      labelCode: string;
      approvalRequired: boolean;
    }>;
  };
  stages: Array<{
    code: string;
    labelCode: string;
    approvalRequired: boolean;
    approvalStatus: OpenMontageApprovalStatus;
    status: OpenMontageStageStatus;
    attempt: number;
    progress?: OpenMontageStageProjection["progress"];
    startedAt?: string;
    completedAt?: string;
  }>;
  currentStage: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
}

export type ApplyOpenMontageJobEventOutcome =
  | "applied"
  | "duplicate"
  | "gap"
  | "ignored_terminal";

export function parseOpenMontageJobEvent(value: unknown): OpenMontageJobEvent {
  const source = requireObject(value, "OpenMontage event");
  assertExactKeys(source, [
    "schemaVersion",
    "eventId",
    "eventType",
    "occurredAt",
    "jobId",
    "sequence",
    "workspaceId",
    "employeeId",
    "runtimeId",
    "rootTaskId",
    "conversationId",
    "sourceInvocationId",
    "traceId",
    "payload",
  ]);
  if (source.schemaVersion !== 1) {
    throw new Error("OpenMontage event schemaVersion must be 1.");
  }
  if (!isOpenMontageJobEventType(source.eventType)) {
    throw new Error("OpenMontage eventType is not supported.");
  }
  const occurredAt = requireTimestamp(source.occurredAt, "occurredAt");
  const sequence = requirePositiveInteger(source.sequence, "sequence");
  const payload = requireObject(source.payload, "payload");
  validatePayload(source.eventType, payload);
  return {
    schemaVersion: 1,
    eventId: requireIdentifier(source.eventId, "eventId"),
    eventType: source.eventType,
    occurredAt,
    jobId: requireIdentifier(source.jobId, "jobId"),
    sequence,
    workspaceId: requireIdentifier(source.workspaceId, "workspaceId"),
    employeeId: requireIdentifier(source.employeeId, "employeeId"),
    runtimeId: requireIdentifier(source.runtimeId, "runtimeId"),
    rootTaskId: requireIdentifier(source.rootTaskId, "rootTaskId"),
    conversationId: requireIdentifier(source.conversationId, "conversationId"),
    sourceInvocationId: requireIdentifier(source.sourceInvocationId, "sourceInvocationId"),
    traceId: requireIdentifier(source.traceId, "traceId"),
    payload: structuredClone(payload),
  };
}

export function createOpenMontageJobProjection(
  snapshot: OpenMontageJobSnapshotSeed,
): OpenMontageJobProjection {
  if (snapshot.schemaVersion !== 1) {
    throw new Error("OpenMontage snapshot schemaVersion must be 1.");
  }
  requireIdentifier(snapshot.jobId, "jobId");
  requireIdentifier(snapshot.workflow.name, "workflow.name");
  requireIdentifier(snapshot.workflow.version, "workflow.version");
  requireNonNegativeInteger(snapshot.lastSequence, "lastSequence");
  const manifestStages = new Set(snapshot.workflow.stages.map((stage) => stage.code));
  if (manifestStages.size !== snapshot.workflow.stages.length || snapshot.stages.length !== manifestStages.size) {
    throw new Error("OpenMontage snapshot stages must match the workflow definition.");
  }
  for (const stage of snapshot.stages) {
    if (!manifestStages.has(stage.code)) {
      throw new Error(`Unknown OpenMontage stage "${stage.code}".`);
    }
  }
  return {
    schemaVersion: 1,
    jobId: snapshot.jobId,
    status: snapshot.status,
    workflow: {
      name: snapshot.workflow.name,
      version: snapshot.workflow.version,
    },
    stages: structuredClone(snapshot.stages),
    currentStage: snapshot.currentStage,
    artifacts: [],
    lastAppliedSequence: snapshot.lastSequence,
    syncStatus: "CURRENT",
    nextExpectedSequence: snapshot.lastSequence + 1,
    createdAt: requireTimestamp(snapshot.createdAt, "createdAt"),
    updatedAt: requireTimestamp(snapshot.updatedAt, "updatedAt"),
  };
}

export function applyOpenMontageJobEvent(
  current: OpenMontageJobProjection,
  event: OpenMontageJobEvent,
): { projection: OpenMontageJobProjection; outcome: ApplyOpenMontageJobEventOutcome } {
  if (current.jobId !== event.jobId) {
    throw new Error("OpenMontage event jobId does not match the projection.");
  }
  if (event.sequence <= current.lastAppliedSequence) {
    return { projection: current, outcome: "duplicate" };
  }
  if (event.sequence > current.lastAppliedSequence + 1) {
    return {
      projection: {
        ...current,
        syncStatus: "SYNCING",
        nextExpectedSequence: current.lastAppliedSequence + 1,
      },
      outcome: "gap",
    };
  }

  const projection = structuredClone(current);
  projection.lastAppliedSequence = event.sequence;
  projection.nextExpectedSequence = event.sequence + 1;
  projection.syncStatus = "CURRENT";
  projection.updatedAt = event.occurredAt;

  if (isTerminalJobStatus(current.status)) {
    return { projection, outcome: "ignored_terminal" };
  }

  switch (event.eventType) {
    case "openmontage.job.created":
      projection.status = "QUEUED";
      break;
    case "openmontage.stage.started": {
      const stage = requireProjectedStage(projection, event.payload.stage);
      stage.status = "RUNNING";
      stage.attempt = requirePositiveInteger(event.payload.stageAttempt, "payload.stageAttempt");
      stage.startedAt = event.occurredAt;
      stage.completedAt = undefined;
      projection.status = "RUNNING";
      projection.currentStage = stage.code;
      break;
    }
    case "openmontage.stage.progressed": {
      const stage = requireProjectedStage(projection, event.payload.stage);
      const progress = requireObject(event.payload.progress, "payload.progress");
      stage.status = "RUNNING";
      stage.progress = {
        completedUnits: requireNonNegativeInteger(progress.completedUnits, "payload.progress.completedUnits"),
        totalUnits: requirePositiveInteger(progress.totalUnits, "payload.progress.totalUnits"),
        labelCode: requireIdentifier(progress.labelCode, "payload.progress.labelCode"),
      };
      projection.status = "RUNNING";
      projection.currentStage = stage.code;
      break;
    }
    case "openmontage.stage.completed": {
      const stage = requireProjectedStage(projection, event.payload.stage);
      stage.status = "SUCCEEDED";
      stage.completedAt = event.occurredAt;
      projection.currentStage = null;
      break;
    }
    case "openmontage.job.waiting_approval": {
      const stage = requireProjectedStage(projection, event.payload.stage);
      stage.status = "WAITING_APPROVAL";
      stage.approvalStatus = "PENDING";
      projection.status = "WAITING_APPROVAL";
      projection.currentStage = stage.code;
      break;
    }
    case "openmontage.approval.resolved": {
      const stage = requireProjectedStage(projection, event.payload.stage);
      const approved = requireBoolean(event.payload.approved, "payload.approved");
      stage.approvalStatus = approved ? "APPROVED" : "REJECTED";
      stage.status = approved ? "RUNNING" : "FAILED";
      projection.status = approved ? "RUNNING" : "WAITING_APPROVAL";
      projection.currentStage = stage.code;
      break;
    }
    case "openmontage.usage.updated":
      projection.usageSummary = structuredClone(event.payload);
      break;
    case "openmontage.artifact.published":
      projection.artifacts = mergeArtifact(projection.artifacts, event.payload);
      break;
    case "openmontage.job.completed":
      projection.status = "SUCCEEDED";
      projection.currentStage = null;
      break;
    case "openmontage.job.failed":
      projection.status = "FAILED";
      projection.currentStage = typeof event.payload.stage === "string" ? event.payload.stage : projection.currentStage;
      projection.error = requireObject(event.payload.error, "payload.error");
      break;
    case "openmontage.job.cancel_requested":
      projection.status = "CANCEL_REQUESTED";
      break;
    case "openmontage.job.cancelled":
      projection.status = "CANCELLED";
      projection.currentStage = null;
      break;
  }

  return { projection, outcome: "applied" };
}

export function isOpenMontageJobEventType(value: unknown): value is OpenMontageJobEventType {
  return typeof value === "string" && (OPENMONTAGE_JOB_EVENT_TYPES as readonly string[]).includes(value);
}

function validatePayload(eventType: OpenMontageJobEventType, payload: Record<string, unknown>): void {
  if (eventType === "openmontage.job.created") {
    assertExactKeys(payload, ["workflow"]);
    const workflow = requireObject(payload.workflow, "payload.workflow");
    assertExactKeys(workflow, ["name", "version"]);
    requireIdentifier(workflow.name, "payload.workflow.name");
    requireIdentifier(workflow.version, "payload.workflow.version");
    return;
  }
  if (eventType.startsWith("openmontage.stage.") || eventType === "openmontage.job.waiting_approval" || eventType === "openmontage.approval.resolved") {
    requireIdentifier(payload.stage, "payload.stage");
    requirePositiveInteger(payload.stageAttempt, "payload.stageAttempt");
    if (eventType === "openmontage.stage.progressed") {
      const progress = requireObject(payload.progress, "payload.progress");
      assertExactKeys(progress, ["completedUnits", "totalUnits", "labelCode"]);
      const completed = requireNonNegativeInteger(progress.completedUnits, "payload.progress.completedUnits");
      const total = requirePositiveInteger(progress.totalUnits, "payload.progress.totalUnits");
      if (completed > total) {
        throw new Error("payload.progress.completedUnits cannot exceed totalUnits.");
      }
      requireIdentifier(progress.labelCode, "payload.progress.labelCode");
    }
    if (eventType === "openmontage.approval.resolved") {
      requireBoolean(payload.approved, "payload.approved");
    }
    return;
  }
  if (eventType === "openmontage.job.failed") {
    const error = requireObject(payload.error, "payload.error");
    assertExactKeys(error, ["code", "message", "retryable"]);
    requireIdentifier(error.code, "payload.error.code");
    requireShortText(error.message, "payload.error.message", 500);
    requireBoolean(error.retryable, "payload.error.retryable");
  }
}

function requireProjectedStage(
  projection: OpenMontageJobProjection,
  code: unknown,
): OpenMontageStageProjection {
  const normalized = requireIdentifier(code, "payload.stage");
  const stage = projection.stages.find((candidate) => candidate.code === normalized);
  if (!stage) {
    throw new Error(`Unknown OpenMontage stage "${normalized}".`);
  }
  return stage;
}

function mergeArtifact(
  artifacts: Record<string, unknown>[],
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : undefined;
  if (!artifactId) {
    return [...artifacts, structuredClone(payload)];
  }
  return [...artifacts.filter((item) => item.artifactId !== artifactId), structuredClone(payload)];
}

function isTerminalJobStatus(status: OpenMontageJobStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(source: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(source).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new Error(`OpenMontage contract contains unexpected field "${unexpected}".`);
  }
  const missing = allowed.find((key) => !(key in source));
  if (missing) {
    throw new Error(`OpenMontage contract is missing field "${missing}".`);
  }
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`${field} must be a non-empty string of at most 256 characters.`);
  }
  return value;
}

function requireShortText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be boolean.`);
  }
  return value;
}
