import {
  advanceWorkflowTriggerSync,
  claimDueWorkflowTriggersSync,
  getDatabase,
  recordAuditLogSync,
  withTransaction,
  type UpsertWorkflowTriggerInput,
  type WorkflowTriggerRecord,
} from "@dofe-agent/db";
import { isWorkflowEventName } from "@dofe-agent/domain";
import { CronExpressionParser } from "cron-parser";
import { materializeWorkflowRunSync } from "./materialization.ts";
import { expireWorkflowApprovalsSync, type WorkflowApprovalExpiryFailure } from "./coordinator.ts";

type PublishWorkflowTriggerInput = Omit<UpsertWorkflowTriggerInput, "workspaceId" | "workflowId">;

export interface WorkflowSchedulerTickResult {
  claimedTriggerIds: string[];
  createdRunIds: string[];
  deduplicatedTriggerIds: string[];
  misfiredTriggerIds: string[];
  failedTriggerIds: string[];
  // 本轮扫描中因审批限时到期而自动驳回的审批 ID。
  expiredApprovalIds: string[];
  // 本轮审批限时扫描中处理失败（事务回滚/并发冲突）的审批，含 workspaceId/runId/
  // approvalId/errorCode，供告警与值班定位。持续性失败不再被静默重试。
  expiredApprovalFailures: WorkflowApprovalExpiryFailure[];
}

export function tickWorkflowSchedulerSync(input: {
  now: string;
  workerId: string;
  limit: number;
  workspaceId?: string;
}): WorkflowSchedulerTickResult {
  const triggers = claimDueWorkflowTriggersSync({ ...input, leaseSeconds: 60 });
  const result: WorkflowSchedulerTickResult = {
    claimedTriggerIds: triggers.map((trigger) => trigger.id),
    createdRunIds: [],
    deduplicatedTriggerIds: [],
    misfiredTriggerIds: [],
    failedTriggerIds: [],
    expiredApprovalIds: [],
    expiredApprovalFailures: [],
  };
  for (const trigger of triggers) {
    const scheduledAt = trigger.nextFireAt;
    if (!scheduledAt) {
      releaseTrigger(trigger, input.workerId, input.now, null, "paused", undefined, {
        code: "workflow.trigger.invalid",
        reasonCode: "workflow_trigger_next_fire_missing",
      });
      result.failedTriggerIds.push(trigger.id);
      continue;
    }
    const oneTime = isOneTimeWorkflowTrigger(trigger);
    const decision = resolveWorkflowScheduleDecision(trigger, input.now);
    if (!decision.nextFireAt && !oneTime) {
      releaseTrigger(trigger, input.workerId, input.now, null, "paused", undefined, {
        code: "workflow.trigger.invalid",
        reasonCode: "workflow_schedule_invalid",
      });
      result.failedTriggerIds.push(trigger.id);
      continue;
    }
    if (!decision.runScheduledAt) {
      releaseTrigger(trigger, input.workerId, input.now, decision.nextFireAt, oneTime ? "paused" : undefined, scheduledAt, {
        code: "workflow.trigger.misfire_skipped",
        reasonCode: "misfire_grace_exceeded",
      });
      result.misfiredTriggerIds.push(trigger.id);
      continue;
    }
    try {
      const materialized = materializeWorkflowRunSync({
        workspaceId: trigger.workspaceId,
        trigger,
        scheduledAt: decision.runScheduledAt,
        now: input.now,
        triggerAdvance: {
          workerId: input.workerId,
          nextFireAt: decision.nextFireAt,
          status: oneTime ? "paused" : undefined,
          misfired: decision.misfired,
          outcome: decision.misfired ? {
            code: "workflow.trigger.misfire_fire_once",
            reasonCode: "misfire_grace_exceeded",
          } : undefined,
        },
      });
      if (decision.misfired) result.misfiredTriggerIds.push(trigger.id);
      if (materialized.created) result.createdRunIds.push(materialized.runId);
      else result.deduplicatedTriggerIds.push(trigger.id);
    } catch (error) {
      const disposition = workflowSchedulerFailureDisposition(error);
      if (disposition === "suspend") {
        releaseTrigger(trigger, input.workerId, input.now, scheduledAt, "paused", undefined, {
          code: "workflow.trigger.invalid",
          reasonCode: workflowSchedulerErrorCode(error),
        });
      } else if (disposition === "retry") {
        recordSchedulerOutcomeBestEffort(trigger, input.now, {
          code: "workflow.trigger.materialization_failed",
          reasonCode: workflowSchedulerErrorCode(error),
        });
      }
      if (disposition !== "stale") result.failedTriggerIds.push(trigger.id);
    }
  }
  // 审批限时扫描：与触发器物化解耦，统一在本轮 tick 末尾执行，避免等待中的审批无限期挂起。
  // 当调度器以工作区范围调用（workspaceId）时，扫描必须同样限定在该工作区内，
  // 不得越界处理其他工作区的审批。单条审批失败以结构化 failures 上报（已各自写审计日志），
  // 不再静默；非法时钟等整轮失败同样记录审计日志，便于告警与值班定位。
  try {
    const expiry = expireWorkflowApprovalsSync({ now: input.now, limit: input.limit, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) });
    result.expiredApprovalIds = expiry.expiredApprovalIds;
    result.expiredApprovalFailures = expiry.failures;
  } catch (error) {
    // 整轮扫描失败（如非法时钟）不阻断本轮触发器处理结果；记录审计日志后下一轮 tick 重试。
    recordApprovalScanFailureBestEffort(input.workspaceId, error, input.now);
  }
  return result;
}

export function workflowSchedulerFailureDisposition(error: unknown): "stale" | "suspend" | "retry" {
  const code = workflowSchedulerErrorCode(error);
  if ([
    "workflow_definition_not_found",
    "workflow_definition_not_published",
    "workflow_trigger_not_active",
    "workflow_trigger_stale_snapshot",
    "workflow_trigger_lease_conflict",
  ].includes(code)) return "stale";
  if (code === "workflow_active_version_missing" || error instanceof SyntaxError) return "suspend";
  return "retry";
}

export function resolveWorkflowScheduleDecision(
  trigger: WorkflowTriggerRecord,
  now: string,
): { runScheduledAt: string | null; nextFireAt: string | null; misfired: boolean } {
  const scheduledAt = trigger.nextFireAt;
  if (!scheduledAt) return { runScheduledAt: null, nextFireAt: null, misfired: true };
  const nowMillis = Date.parse(now);
  const scheduledMillis = Date.parse(scheduledAt);
  if (!Number.isFinite(nowMillis) || !Number.isFinite(scheduledMillis)) {
    return { runScheduledAt: null, nextFireAt: null, misfired: true };
  }
  const config = parseScheduleConfig(trigger.configJson);
  const configuredGrace = Number(config?.misfireGraceSeconds);
  const graceSeconds = Number.isInteger(configuredGrace) && configuredGrace >= 0 && configuredGrace <= 86_400
    ? configuredGrace
    : 60;
  const misfired = nowMillis - scheduledMillis > graceSeconds * 1_000;
  if (isOneTimeWorkflowTrigger(trigger)) {
    return {
      runScheduledAt: !misfired || trigger.misfirePolicy === "fire_once" ? scheduledAt : null,
      nextFireAt: null,
      misfired,
    };
  }

  const nextAfterScheduled = computeNextWorkflowFireAt(trigger, scheduledAt, now);
  const window = nextAfterScheduled && Date.parse(nextAfterScheduled) > nowMillis
    ? { latestDueAt: scheduledAt, nextFireAt: nextAfterScheduled }
    : recurringWindowAroundNow(trigger, scheduledAt, now);
  if (!window) return { runScheduledAt: null, nextFireAt: null, misfired: true };
  return {
    runScheduledAt: misfired
      ? trigger.misfirePolicy === "fire_once" ? window.latestDueAt : null
      : scheduledAt,
    nextFireAt: window.nextFireAt,
    misfired,
  };
}

function recurringWindowAroundNow(
  trigger: WorkflowTriggerRecord,
  scheduledAt: string,
  now: string,
): { latestDueAt: string; nextFireAt: string } | null {
  const config = parseScheduleConfig(trigger.configJson);
  if (!config) return null;
  const scheduledMillis = Date.parse(scheduledAt);
  const nowMillis = Date.parse(now);
  const repeatSeconds = Number(config.repeatSeconds ?? config.intervalSeconds);
  if (Number.isFinite(repeatSeconds) && repeatSeconds > 0) {
    const intervalMillis = repeatSeconds * 1_000;
    const elapsedIntervals = Math.max(0, Math.floor((nowMillis - scheduledMillis) / intervalMillis));
    const latestDueMillis = scheduledMillis + elapsedIntervals * intervalMillis;
    return {
      latestDueAt: new Date(latestDueMillis).toISOString(),
      nextFireAt: new Date(latestDueMillis + intervalMillis).toISOString(),
    };
  }
  const dailyAt = typeof config.dailyAt === "string" ? config.dailyAt : undefined;
  const dailyMatch = dailyAt ? /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(dailyAt) : null;
  const cronExpression = dailyMatch
    ? `${Number(dailyAt!.slice(3, 5))} ${Number(dailyAt!.slice(0, 2))} * * *`
    : typeof config.cronExpression === "string"
      ? config.cronExpression
      : typeof config.cron === "string" ? config.cron : undefined;
  if (!cronExpression) return null;
  try {
    const timezone = trigger.timezone ?? "UTC";
    const latestDueAt = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(nowMillis + 1).toISOString(),
      tz: timezone,
    }).prev().toISOString();
    const nextFireAt = CronExpressionParser.parse(cronExpression, { currentDate: now, tz: timezone }).next().toISOString();
    if (!latestDueAt || !nextFireAt) return null;
    return Date.parse(latestDueAt) >= scheduledMillis ? { latestDueAt, nextFireAt } : null;
  } catch {
    return null;
  }
}

export function computeNextWorkflowFireAt(trigger: WorkflowTriggerRecord, scheduledAt: string, now: string): string | null {
  const config = parseScheduleConfig(trigger.configJson);
  if (!config) return null;
  if (typeof config.onceAt === "string") return null;
  const repeatSeconds = Number(config.repeatSeconds ?? config.intervalSeconds);
  if (Number.isFinite(repeatSeconds) && repeatSeconds > 0) {
    return new Date(Date.parse(scheduledAt) + repeatSeconds * 1000).toISOString();
  }
  const dailyAt = typeof config.dailyAt === "string" ? config.dailyAt : undefined;
  if (dailyAt) return nextDailyAt(scheduledAt, dailyAt, trigger.timezone ?? "UTC");
  const cronExpression = typeof config.cronExpression === "string"
    ? config.cronExpression
    : typeof config.cron === "string" ? config.cron : undefined;
  if (cronExpression) return nextCronAt(cronExpression, scheduledAt, trigger.timezone ?? "UTC");
  return null;
}

export function isOneTimeWorkflowTrigger(trigger: Pick<WorkflowTriggerRecord, "configJson">): boolean {
  const config = parseScheduleConfig(trigger.configJson);
  return typeof config?.onceAt === "string";
}

export function normalizeWorkflowTriggerForPublish(
  input: PublishWorkflowTriggerInput,
  now = input.now ?? new Date().toISOString(),
): PublishWorkflowTriggerInput {
  const misfirePolicy = input.misfirePolicy ?? "skip";
  if (misfirePolicy !== "skip" && misfirePolicy !== "fire_once") {
    throw new Error("workflow_misfire_policy_invalid");
  }
  if (input.type === "event") {
    const config = parseScheduleConfig(input.configJson);
    const eventName = typeof config?.eventName === "string" ? config.eventName.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventName) || !isWorkflowEventName(eventName)) {
      throw new Error("workflow_event_invalid");
    }
    return { ...input, misfirePolicy, configJson: JSON.stringify({ ...config, eventName }), nextFireAt: undefined };
  }
  if (input.type !== "schedule") return { ...input, misfirePolicy, nextFireAt: undefined };
  const config = parseScheduleConfig(input.configJson);
  if (!config) throw new Error("workflow_schedule_invalid");
  const timezone = input.timezone ?? "UTC";
  if (!isValidTimezone(timezone)) throw new Error("workflow_schedule_timezone_invalid");
  const nowMillis = Date.parse(now);
  if (!Number.isFinite(nowMillis)) throw new Error("workflow_schedule_invalid");

  let nextFireAt: string | null = null;
  if (typeof config.onceAt === "string") {
    const onceMillis = Date.parse(config.onceAt);
    if (!Number.isFinite(onceMillis)) throw new Error("workflow_schedule_invalid");
    if (onceMillis <= nowMillis) throw new Error("workflow_schedule_in_past");
    nextFireAt = new Date(onceMillis).toISOString();
  } else {
    const repeatSeconds = Number(config.repeatSeconds ?? config.intervalSeconds);
    if (Number.isFinite(repeatSeconds) && repeatSeconds > 0) {
      nextFireAt = new Date(nowMillis + repeatSeconds * 1000).toISOString();
    } else if (typeof config.dailyAt === "string") {
      nextFireAt = firstDailyAt(now, config.dailyAt, timezone);
    } else {
      const cronExpression = typeof config.cronExpression === "string"
        ? config.cronExpression
        : typeof config.cron === "string" ? config.cron : undefined;
      if (cronExpression) nextFireAt = nextCronAt(cronExpression, now, timezone);
    }
  }
  if (!nextFireAt) throw new Error("workflow_schedule_invalid");
  return { ...input, misfirePolicy, timezone, nextFireAt };
}

function nextDailyAt(scheduledAt: string, dailyAt: string, timezone: string): string | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(dailyAt);
  if (!match) return null;
  const [hour, minute] = dailyAt.split(":").map(Number);
  const parts = zonedParts(new Date(scheduledAt), timezone);
  if (!parts) return null;
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, hour, minute));
  return localDateToUtc(localDate, timezone);
}

function firstDailyAt(now: string, dailyAt: string, timezone: string): string | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(dailyAt);
  if (!match) return null;
  const [hour, minute] = dailyAt.split(":").map(Number);
  const parts = zonedParts(new Date(now), timezone);
  if (!parts) return null;
  let localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute));
  let candidate = localDateToUtc(localDate, timezone);
  if (candidate && Date.parse(candidate) <= Date.parse(now)) {
    localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, hour, minute));
    candidate = localDateToUtc(localDate, timezone);
  }
  return candidate;
}

function nextCronAt(expression: string, currentDate: string, timezone: string): string | null {
  try {
    return CronExpressionParser.parse(expression, { currentDate, tz: timezone }).next().toISOString();
  } catch {
    return null;
  }
}

function parseScheduleConfig(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return { year: values.year, month: values.month, day: values.day };
  } catch {
    return null;
  }
}

function localDateToUtc(localDate: Date, timezone: string): string | null {
  let guess = localDate.getTime();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const date = new Date(guess);
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
      const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
      const localMillis = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
      guess += localDate.getTime() - localMillis;
    } catch {
      return null;
    }
  }
  return new Date(guess).toISOString();
}

interface WorkflowSchedulerOutcome {
  code: "workflow.trigger.misfire_skipped" | "workflow.trigger.misfire_fire_once" | "workflow.trigger.invalid" | "workflow.trigger.materialization_failed";
  reasonCode: string;
  scheduledAt?: string;
}

function releaseTrigger(
  trigger: WorkflowTriggerRecord,
  workerId: string,
  now: string,
  nextFireAt: string | null,
  status?: string,
  lastFireAt?: string,
  outcome?: WorkflowSchedulerOutcome,
): void {
  withTransaction(getDatabase(), () => {
    const advanced = advanceWorkflowTriggerSync({ id: trigger.id, workspaceId: trigger.workspaceId, workerId, nextFireAt, lastFireAt, status, now });
    if (!advanced) return;
    if (outcome) recordSchedulerOutcome(trigger, now, outcome);
  });
}

function recordSchedulerOutcomeBestEffort(trigger: WorkflowTriggerRecord, now: string, outcome: WorkflowSchedulerOutcome): void {
  try {
    recordSchedulerOutcome(trigger, now, outcome);
  } catch {
    // A transient storage failure must not convert a retryable trigger into a permanent failure.
  }
}

/**
 * 整轮审批限时扫描失败（如非法时钟）的尽力争力记录：写入审计日志，供告警与值班定位。
 * 审计写入本身失败不放大故障，下一轮 tick 仍会重试扫描。
 */
function recordApprovalScanFailureBestEffort(workspaceId: string | undefined, error: unknown, now: string): void {
  try {
    const code = error instanceof Error && /^workflow_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "workflow_approval_scan_failed";
    recordAuditLogSync({
      ...(workspaceId ? { workspaceId } : {}),
      title: "Workflow approval deadline scan failed",
      note: "approval_deadline_scan_failed",
      code,
      source: "runtime_lifecycle",
      data: { reasonCode: code, occurredAt: now },
    });
  } catch {
    // 审计不可写时不应放大故障；下一轮 tick 仍会重试。
  }
}

function recordSchedulerOutcome(trigger: WorkflowTriggerRecord, now: string, outcome: WorkflowSchedulerOutcome): void {
  recordAuditLogSync({
    workspaceId: trigger.workspaceId,
    title: "Workflow trigger outcome",
    note: outcome.reasonCode,
    code: outcome.code,
    data: {
      workflowId: trigger.workflowId,
      triggerId: trigger.id,
      scheduledAt: outcome.scheduledAt ?? trigger.nextFireAt,
      policy: trigger.misfirePolicy,
      reasonCode: outcome.reasonCode,
      occurredAt: now,
    },
  });
}

function workflowSchedulerErrorCode(error: unknown): string {
  return error instanceof Error && /^workflow_[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "workflow_materialization_transient_failure";
}
