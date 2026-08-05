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

export const OPENMONTAGE_MCP_CATALOG_SLUG = "official-openmontage";

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

export interface OpenMontageJobAttribution {
  workspaceId: string;
  employeeId: string;
  runtimeId: string;
  rootTaskId: string;
  conversationId: string;
  sourceInvocationId: string;
  traceId: string;
}

export interface OpenMontageSubmittedJob {
  attribution: OpenMontageJobAttribution;
  clientRequestId: string;
  budget: {
    maxAmount: string;
    currency: string;
  };
  snapshot: OpenMontageJobSnapshotSeed;
}

export type ApplyOpenMontageJobEventOutcome =
  | "applied"
  | "duplicate"
  | "gap"
  | "ignored_terminal";

export function parseOpenMontageSubmittedJob(value: unknown): OpenMontageSubmittedJob {
  const source = requireObject(value, "OpenMontage submitted Job");
  assertKeys(source, [
    "schemaVersion",
    "jobId",
    "status",
    "workflow",
    "attribution",
    "request",
    "stages",
    "lastSequence",
    "createdAt",
    "updatedAt",
  ], ["currentStage"]);
  if (source.schemaVersion !== 1) {
    throw new Error("OpenMontage snapshot schemaVersion must be 1.");
  }

  const workflow = requireObject(source.workflow, "workflow");
  assertExactKeys(workflow, ["name", "version", "stages"]);
  if (!Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    throw new Error("workflow.stages must be a non-empty array.");
  }
  const workflowStages = workflow.stages.map((value, index) => {
    const stage = requireObject(value, `workflow.stages[${index}]`);
    assertExactKeys(stage, ["code", "labelCode", "approvalRequired"]);
    return {
      code: requireIdentifier(stage.code, `workflow.stages[${index}].code`),
      labelCode: requireIdentifier(stage.labelCode, `workflow.stages[${index}].labelCode`),
      approvalRequired: requireBoolean(stage.approvalRequired, `workflow.stages[${index}].approvalRequired`),
    };
  });

  const attributionSource = requireObject(source.attribution, "attribution");
  assertExactKeys(attributionSource, [
    "workspaceId",
    "employeeId",
    "runtimeId",
    "rootTaskId",
    "conversationId",
    "sourceInvocationId",
    "traceId",
  ]);
  const attribution: OpenMontageJobAttribution = {
    workspaceId: requireIdentifier(attributionSource.workspaceId, "attribution.workspaceId"),
    employeeId: requireIdentifier(attributionSource.employeeId, "attribution.employeeId"),
    runtimeId: requireIdentifier(attributionSource.runtimeId, "attribution.runtimeId"),
    rootTaskId: requireIdentifier(attributionSource.rootTaskId, "attribution.rootTaskId"),
    conversationId: requireIdentifier(attributionSource.conversationId, "attribution.conversationId"),
    sourceInvocationId: requireIdentifier(attributionSource.sourceInvocationId, "attribution.sourceInvocationId"),
    traceId: requireIdentifier(attributionSource.traceId, "attribution.traceId"),
  };

  const request = requireObject(source.request, "request");
  assertExactKeys(request, ["schemaVersion", "clientRequestId", "workflow", "input", "brief", "output", "budget"]);
  if (request.schemaVersion !== 1) throw new Error("request.schemaVersion must be 1.");
  const clientRequestId = requireIdentifier(request.clientRequestId, "request.clientRequestId");
  const requestedWorkflow = requireIdentifier(request.workflow, "request.workflow");
  for (const field of ["input", "brief", "output", "budget"] as const) {
    requireObject(request[field], `request.${field}`);
  }
  const budgetSource = request.budget as Record<string, unknown>;
  assertExactKeys(budgetSource, ["maxAmount", "currency"]);
  const budget = {
    maxAmount: requireAmount(budgetSource.maxAmount, "request.budget.maxAmount"),
    currency: requireCurrency(budgetSource.currency, "request.budget.currency"),
  };

  if (!Array.isArray(source.stages) || source.stages.length === 0) {
    throw new Error("stages must be a non-empty array.");
  }
  const stages = source.stages.map((value, index) => parseSubmittedStage(value, index));
  const status = requireJobStatus(source.status, "status");
  const currentStage = source.currentStage === undefined || source.currentStage === null
    ? null
    : requireIdentifier(source.currentStage, "currentStage");
  const snapshot: OpenMontageJobSnapshotSeed = {
    schemaVersion: 1,
    jobId: requireIdentifier(source.jobId, "jobId"),
    status,
    workflow: {
      name: requireIdentifier(workflow.name, "workflow.name"),
      version: requireIdentifier(workflow.version, "workflow.version"),
      stages: workflowStages,
    },
    stages,
    currentStage,
    lastSequence: requireNonNegativeInteger(source.lastSequence, "lastSequence"),
    createdAt: requireTimestamp(source.createdAt, "createdAt"),
    updatedAt: requireTimestamp(source.updatedAt, "updatedAt"),
  };
  if (requestedWorkflow !== snapshot.workflow.name) {
    throw new Error("request.workflow must match workflow.name.");
  }
  createOpenMontageJobProjection(snapshot);
  return { attribution, clientRequestId, budget, snapshot };
}

function requireAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{1,10}(?:\.\d{1,8})?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive decimal string.`);
  }
  return value;
}

function requireCurrency(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z]{3,10}$/.test(value)) {
    throw new Error(`${field} must be an uppercase currency code.`);
  }
  return value;
}

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
  if (
    source.eventType === "openmontage.artifact.published"
    && payload.employeeId !== source.employeeId
  ) {
    throw new Error("payload.employeeId must match the trusted event employeeId.");
  }
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
    return;
  }
  if (eventType === "openmontage.artifact.published") {
    assertExactKeys(payload, [
      "artifactId",
      "employeeId",
      "role",
      "fileName",
      "mediaType",
      "sizeBytes",
      "sha256",
      "publishedAt",
    ]);
    requireIdentifier(payload.artifactId, "payload.artifactId");
    requireIdentifier(payload.employeeId, "payload.employeeId");
    requireIdentifier(payload.role, "payload.role");
    requireSafeFileName(payload.fileName, "payload.fileName");
    requireShortText(payload.mediaType, "payload.mediaType", 255);
    requirePositiveInteger(payload.sizeBytes, "payload.sizeBytes");
    requireSha256(payload.sha256, "payload.sha256");
    requireTimestamp(payload.publishedAt, "payload.publishedAt");
  }
}

function parseSubmittedStage(value: unknown, index: number): OpenMontageJobSnapshotSeed["stages"][number] {
  const stage = requireObject(value, `stages[${index}]`);
  assertKeys(stage, ["code", "labelCode", "approvalRequired", "approvalStatus", "status", "attempt"], ["progress", "startedAt", "completedAt"]);
  const parsed: OpenMontageJobSnapshotSeed["stages"][number] = {
    code: requireIdentifier(stage.code, `stages[${index}].code`),
    labelCode: requireIdentifier(stage.labelCode, `stages[${index}].labelCode`),
    approvalRequired: requireBoolean(stage.approvalRequired, `stages[${index}].approvalRequired`),
    approvalStatus: requireApprovalStatus(stage.approvalStatus, `stages[${index}].approvalStatus`),
    status: requireStageStatus(stage.status, `stages[${index}].status`),
    attempt: requireNonNegativeInteger(stage.attempt, `stages[${index}].attempt`),
  };
  if (stage.progress !== undefined) {
    const progress = requireObject(stage.progress, `stages[${index}].progress`);
    assertExactKeys(progress, ["completedUnits", "totalUnits", "labelCode"]);
    const completedUnits = requireNonNegativeInteger(progress.completedUnits, `stages[${index}].progress.completedUnits`);
    const totalUnits = requirePositiveInteger(progress.totalUnits, `stages[${index}].progress.totalUnits`);
    if (completedUnits > totalUnits) throw new Error(`stages[${index}].progress.completedUnits cannot exceed totalUnits.`);
    parsed.progress = {
      completedUnits,
      totalUnits,
      labelCode: requireIdentifier(progress.labelCode, `stages[${index}].progress.labelCode`),
    };
  }
  if (stage.startedAt !== undefined) parsed.startedAt = requireTimestamp(stage.startedAt, `stages[${index}].startedAt`);
  if (stage.completedAt !== undefined) parsed.completedAt = requireTimestamp(stage.completedAt, `stages[${index}].completedAt`);
  return parsed;
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

function assertKeys(source: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(source).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`OpenMontage contract contains unexpected field "${unexpected}".`);
  const missing = required.find((key) => !(key in source));
  if (missing) throw new Error(`OpenMontage contract is missing field "${missing}".`);
}

function requireJobStatus(value: unknown, field: string): OpenMontageJobStatus {
  if (typeof value !== "string" || !(["QUEUED", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED"] as const).includes(value as OpenMontageJobStatus)) {
    throw new Error(`${field} is not a supported Job status.`);
  }
  return value as OpenMontageJobStatus;
}

function requireStageStatus(value: unknown, field: string): OpenMontageStageStatus {
  if (typeof value !== "string" || !(["PENDING", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"] as const).includes(value as OpenMontageStageStatus)) {
    throw new Error(`${field} is not a supported stage status.`);
  }
  return value as OpenMontageStageStatus;
}

function requireApprovalStatus(value: unknown, field: string): OpenMontageApprovalStatus {
  if (typeof value !== "string" || !(["NOT_REQUIRED", "REQUIRED", "PENDING", "APPROVED", "REJECTED"] as const).includes(value as OpenMontageApprovalStatus)) {
    throw new Error(`${field} is not a supported approval status.`);
  }
  return value as OpenMontageApprovalStatus;
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

function requireSafeFileName(value: unknown, field: string): string {
  const fileName = requireShortText(value, field, 255);
  if (
    fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw new Error(`${field} must be a safe base name.`);
  }
  return fileName;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest.`);
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
