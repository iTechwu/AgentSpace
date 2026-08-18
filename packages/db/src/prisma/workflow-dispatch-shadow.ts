export interface WorkflowDispatchShadowResult {
  nodeRunId: string;
  taskQueueId?: string;
  status: string;
}

export interface WorkflowDispatchShadowSnapshot {
  result: WorkflowDispatchShadowResult;
  queue: Record<string, unknown> | null;
  routerSession: Record<string, unknown> | null;
  routerEvents: Array<Record<string, unknown>>;
  taskEvent: Record<string, unknown> | null;
  nodeRun: Record<string, unknown> | null;
}

export interface WorkflowDispatchShadowComparison {
  comparedCount: 0 | 1;
  mismatchCount: 0 | 1;
  diffFields: string[];
}

export interface WorkflowDispatchShadowRecordSource {
  result: WorkflowDispatchShadowResult;
  queue: Record<string, unknown> | null;
  routerSession: Record<string, unknown> | null;
  routerEvents: Array<Record<string, unknown>>;
  taskEvent: Record<string, unknown> | null;
  nodeRun: Record<string, unknown> | null;
}

/**
 * Projects Prisma and legacy rows into the same comparison shape. Generated
 * identifiers are retained in the raw snapshot and canonicalized by the
 * comparator because the two runners intentionally use separate transactions.
 */
export function projectWorkflowDispatchShadowSnapshot(source: WorkflowDispatchShadowRecordSource): WorkflowDispatchShadowSnapshot {
  return {
    result: source.result,
    queue: project(source.queue, [
      "id", "workspaceId", "employeeId", "employeeName", "agentId", "runtimeId", "routerSessionId",
      "runtimeCredentialId", "issueId", "triggerType", "priority", "status", "inputJson", "requestedByUserId",
      "requestedByDisplayName", "resultJson", "errorText", "sessionId", "workDir", "bindingGeneration", "queuedAt",
      "claimedAt", "startedAt", "finishedAt", "mcpSessionClaimedAt", "createdAt", "updatedAt",
    ], ["inputJson"]),
    routerSession: project(source.routerSession, [
      "id", "workspaceId", "agentId", "conversationKey", "sourceType", "status", "title", "summary", "memorySummary",
      "modelOverride", "modelOverrideSource", "modelOverrideSetAt", "createdAt", "updatedAt", "closedAt",
    ]),
    routerEvents: source.routerEvents
      .map((event) => project(event, [
        "id", "workspaceId", "routerSessionId", "taskQueueId", "attemptId", "type", "actorType", "actorId", "runtimeId",
        "provider", "summary", "dataJson", "createdAt",
      ], ["dataJson"])!)
      .sort((left, right) => String(left.type).localeCompare(String(right.type))),
    taskEvent: project(source.taskEvent, [
      "id", "workspaceId", "taskId", "channelName", "agentId", "runtimeId", "runId", "type", "title", "summary", "severity", "status", "dataJson", "createdAt",
    ], ["dataJson"]),
    nodeRun: project(source.nodeRun, [
      "id", "workspaceId", "runId", "nodeId", "nodeType", "employeeId", "employeeNameSnapshot", "status", "attemptCount",
      "maxAttempts", "availableAt", "taskQueueId", "approvalId", "approvalDeadline", "approvalScanAfter", "inputJson",
      "outputJson", "artifactManifestJson", "errorCode", "errorMessage", "startedAt", "finishedAt", "createdAt", "updatedAt",
    ], ["inputJson"]),
  };
}

/**
 * Compares the five durable objects written by the workflow dispatcher.
 * Dates are compared by their ISO instant and object keys are traversed in a
 * deterministic order so PostgreSQL JSONB key order cannot create false drift.
 */
export function compareWorkflowDispatchShadow(
  actual: WorkflowDispatchShadowSnapshot,
  expected: WorkflowDispatchShadowSnapshot,
): WorkflowDispatchShadowComparison {
  const diffFields: string[] = [];
  const canonicalActual = canonicalizeSnapshot(actual);
  const canonicalExpected = canonicalizeSnapshot(expected);
  compareValue(canonicalActual.result, canonicalExpected.result, "result", diffFields);
  compareValue(canonicalActual.queue, canonicalExpected.queue, "queue", diffFields);
  compareValue(canonicalActual.routerSession, canonicalExpected.routerSession, "routerSession", diffFields);
  compareValue(canonicalActual.routerEvents, canonicalExpected.routerEvents, "routerEvents", diffFields);
  compareValue(canonicalActual.taskEvent, canonicalExpected.taskEvent, "taskEvent", diffFields);
  compareValue(canonicalActual.nodeRun, canonicalExpected.nodeRun, "nodeRun", diffFields);
  return {
    comparedCount: 1,
    mismatchCount: diffFields.length > 0 ? 1 : 0,
    diffFields,
  };
}

function project(
  value: Record<string, unknown> | null,
  fields: readonly string[],
  jsonFields: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value) return null;
  return Object.fromEntries(fields.map((field) => {
    const raw = value[field];
    if (jsonFields.includes(field) && typeof raw === "string") {
      try {
        return [field, JSON.parse(raw) as unknown];
      } catch {
        return [field, raw];
      }
    }
    return [field, raw ?? null];
  }));
}

function canonicalizeSnapshot(snapshot: WorkflowDispatchShadowSnapshot): WorkflowDispatchShadowSnapshot {
  const canonical = (value: Record<string, unknown> | null, fields: Record<string, { source?: unknown; replacement: string }> = {}) => {
    if (!value) return null;
    const result = { ...value };
    for (const [field, rule] of Object.entries(fields)) {
      const current = result[field];
      if (typeof current === "string" && (rule.source === undefined || current === rule.source)) {
        result[field] = rule.replacement;
      }
    }
    return result;
  };
  const routerSessionId = snapshot.routerSession?.id;
  const taskEventId = snapshot.taskEvent?.id;
  return {
    result: snapshot.result,
    queue: canonical(snapshot.queue, { routerSessionId: { source: routerSessionId, replacement: "$routerSession" } }),
    routerSession: canonical(snapshot.routerSession, { id: { replacement: "$routerSession" } }),
    routerEvents: snapshot.routerEvents.map((event, index) => {
      const normalized = canonical(event, {
        id: { replacement: `$routerEvent[${index}]` },
        routerSessionId: { source: routerSessionId, replacement: "$routerSession" },
      });
      const dataJson = normalized?.dataJson;
      if (dataJson && typeof dataJson === "object" && !Array.isArray(dataJson)) {
        const taskExecutionEventId = (dataJson as Record<string, unknown>).taskExecutionEventId;
        if (typeof taskExecutionEventId === "string" && taskExecutionEventId === taskEventId) {
          normalized.dataJson = { ...(dataJson as Record<string, unknown>), taskExecutionEventId: "$taskEvent" };
        }
      }
      return normalized!;
    }),
    taskEvent: canonical(snapshot.taskEvent, { id: { replacement: "$taskEvent" } }),
    nodeRun: snapshot.nodeRun,
  };
}

function compareValue(actual: unknown, expected: unknown, path: string, diffFields: string[]): void {
  const actualDate = normalizeDate(actual, path);
  const expectedDate = normalizeDate(expected, path);
  if (actualDate !== undefined || expectedDate !== undefined) {
    if (actualDate !== expectedDate) diffFields.push(path);
    return;
  }
  if (Object.is(actual, expected)) return;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") {
    diffFields.push(path);
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      diffFields.push(path);
      return;
    }
    actual.forEach((value, index) => compareValue(value, expected[index], `${path}[${index}]`, diffFields));
    return;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const keys = new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)]);
  for (const key of [...keys].sort()) {
    if (!(key in actualRecord) || !(key in expectedRecord)) {
      diffFields.push(`${path}.${key}`);
      continue;
    }
    compareValue(actualRecord[key], expectedRecord[key], `${path}.${key}`, diffFields);
  }
}

function normalizeDate(value: unknown, path: string): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !/(At|at|Date|date)(?:\]|$)/.test(path)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
