import type {
  CompleteSkillInstallationOperationRequest,
  FailSkillInstallationOperationRequest,
  SkillComponentKind,
  SkillComponentStatus,
  SkillInstallationOperationComponentStatus,
  SkillInstallationOperationExpectedComponent,
} from "@dofe-agent/domain";

/* ------------------------------------------------------------------ */
/* Request snapshot (canonical expected set)                            */
/* ------------------------------------------------------------------ */

const SKILL_COMPONENT_KINDS = new Set<SkillComponentKind>([
  "dependency",
  "script",
  "cli",
  "mcp",
  "service",
]);

const SKILL_COMPONENT_STATUSES = new Set<SkillComponentStatus>([
  "pending",
  "preparing",
  "ready",
  "blocked",
  "failed",
  "degraded",
]);

/**
 * Builds the canonical `request_snapshot_json` for a skill installation
 * operation: the frozen artifact digest + expected component set that a later
 * `complete` must report EXACTLY (no unknown/duplicate/missing components).
 */
export function buildSkillOperationRequestSnapshotJson(input: {
  artifactDigest: string;
  expectedComponents: SkillInstallationOperationExpectedComponent[];
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    artifactDigest: input.artifactDigest,
    expectedComponents: input.expectedComponents,
    ...(input.extra ?? {}),
  });
}

/* ------------------------------------------------------------------ */
/* Shared payload parsing (runtime schema validation)                   */
/* ------------------------------------------------------------------ */

export type ParsedCompleteSkillInstallationOperationPayload = Pick<
  CompleteSkillInstallationOperationRequest,
  "claimGeneration" | "safeResultJson" | "componentStatuses"
>;

export type ParsedFailSkillInstallationOperationPayload = Pick<
  FailSkillInstallationOperationRequest,
  "claimGeneration" | "errorCode" | "errorMessage" | "componentStatuses"
>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseCompleteSkillInstallationOperationPayload(
  body: unknown,
): ParseResult<ParsedCompleteSkillInstallationOperationPayload> {
  const object = parsePlainObject(body);
  if (!object.ok) {
    return object;
  }
  const value = object.value;

  if (!Number.isSafeInteger(value.claimGeneration) || Number(value.claimGeneration) <= 0) {
    return { ok: false, reason: "claimGeneration must be a positive integer." };
  }

  if (value.safeResultJson !== undefined && typeof value.safeResultJson !== "string") {
    return { ok: false, reason: "safeResultJson must be a string." };
  }
  const componentStatuses = parseComponentStatuses(value.componentStatuses);
  if (!componentStatuses.ok) {
    return componentStatuses;
  }
  return {
    ok: true,
    value: {
      claimGeneration: Number(value.claimGeneration),
      ...(value.safeResultJson !== undefined ? { safeResultJson: value.safeResultJson } : {}),
      ...(componentStatuses.value !== undefined ? { componentStatuses: componentStatuses.value } : {}),
    },
  };
}

export function parseFailSkillInstallationOperationPayload(
  body: unknown,
): ParseResult<ParsedFailSkillInstallationOperationPayload> {
  const object = parsePlainObject(body);
  if (!object.ok) {
    return object;
  }
  const value = object.value;

  if (!Number.isSafeInteger(value.claimGeneration) || Number(value.claimGeneration) <= 0) {
    return { ok: false, reason: "claimGeneration must be a positive integer." };
  }

  if (value.errorCode !== undefined && typeof value.errorCode !== "string") {
    return { ok: false, reason: "errorCode must be a string." };
  }
  if (typeof value.errorMessage !== "string") {
    return { ok: false, reason: "errorMessage must be a string." };
  }
  const componentStatuses = parseComponentStatuses(value.componentStatuses);
  if (!componentStatuses.ok) {
    return componentStatuses;
  }
  return {
    ok: true,
    value: {
      claimGeneration: Number(value.claimGeneration),
      ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
      errorMessage: value.errorMessage,
      ...(componentStatuses.value !== undefined ? { componentStatuses: componentStatuses.value } : {}),
    },
  };
}

/**
 * Validates an optional `componentStatuses` array: each entry must carry a
 * known component kind, a non-empty string key, and a known status value.
 * Duplicate `(kind,key)` pairs are rejected — a status must be reported exactly
 * once per component.
 */
function parseComponentStatuses(
  value: unknown,
): ParseResult<SkillInstallationOperationComponentStatus[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: "componentStatuses must be an array." };
  }
  const seen = new Set<string>();
  const statuses: SkillInstallationOperationComponentStatus[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `componentStatuses[${index}] must be an object.` };
    }
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const key = record.key;
    const status = record.status;
    if (typeof kind !== "string" || !SKILL_COMPONENT_KINDS.has(kind as SkillComponentKind)) {
      return { ok: false, reason: `componentStatuses[${index}].kind is not a known component kind.` };
    }
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, reason: `componentStatuses[${index}].key must be a non-empty string.` };
    }
    if (typeof status !== "string" || !SKILL_COMPONENT_STATUSES.has(status as SkillComponentStatus)) {
      return { ok: false, reason: `componentStatuses[${index}].status is not a known status.` };
    }
    const dedupeKey = `${kind}:${key}`;
    if (seen.has(dedupeKey)) {
      return { ok: false, reason: `component "${dedupeKey}" is reported more than once.` };
    }
    seen.add(dedupeKey);
    statuses.push({
      kind: kind as SkillComponentKind,
      key,
      status: status as SkillComponentStatus,
      ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
      ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
    });
  }
  return { ok: true, value: statuses };
}

function parsePlainObject(value: unknown): ParseResult<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "Request body must be a JSON object." };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
