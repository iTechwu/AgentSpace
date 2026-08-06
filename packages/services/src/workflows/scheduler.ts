import {
  advanceWorkflowTriggerSync,
  claimDueWorkflowTriggersSync,
  type UpsertWorkflowTriggerInput,
  type WorkflowTriggerRecord,
} from "@dofe-agent/db";
import { CronExpressionParser } from "cron-parser";
import { materializeWorkflowRunSync } from "./materialization.ts";

type PublishWorkflowTriggerInput = Omit<UpsertWorkflowTriggerInput, "workspaceId" | "workflowId">;

export interface WorkflowSchedulerTickResult {
  claimedTriggerIds: string[];
  createdRunIds: string[];
  deduplicatedTriggerIds: string[];
  misfiredTriggerIds: string[];
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
  };
  for (const trigger of triggers) {
    const scheduledAt = trigger.nextFireAt;
    if (!scheduledAt) {
      releaseTrigger(trigger, input.workerId, input.now, null, "workflow_trigger_invalid");
      result.misfiredTriggerIds.push(trigger.id);
      continue;
    }
    const oneTime = isOneTimeWorkflowTrigger(trigger);
    const next = computeNextWorkflowFireAt(trigger, scheduledAt, input.now);
    if (!next && !oneTime) {
      releaseTrigger(trigger, input.workerId, input.now, null, "paused");
      result.misfiredTriggerIds.push(trigger.id);
      continue;
    }
    const misfired = !oneTime && trigger.misfirePolicy === "skip" && next !== null && Date.parse(next) <= Date.parse(input.now);
    if (misfired) {
      releaseTrigger(trigger, input.workerId, input.now, advanceAfter(trigger, next, input.now), undefined, scheduledAt);
      result.misfiredTriggerIds.push(trigger.id);
      continue;
    }
    try {
      const materialized = materializeWorkflowRunSync({
        workspaceId: trigger.workspaceId,
        trigger,
        scheduledAt,
        now: input.now,
      });
      releaseTrigger(trigger, input.workerId, input.now, next, oneTime ? "paused" : undefined, scheduledAt);
      if (materialized.created) result.createdRunIds.push(materialized.runId);
      else result.deduplicatedTriggerIds.push(trigger.id);
    } catch {
      releaseTrigger(trigger, input.workerId, input.now, scheduledAt, "paused");
      result.misfiredTriggerIds.push(trigger.id);
    }
  }
  return result;
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
  if (input.type !== "schedule") return { ...input, nextFireAt: undefined };
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
  return { ...input, timezone, nextFireAt };
}

function advanceAfter(trigger: WorkflowTriggerRecord, candidate: string, now: string): string | null {
  let next = candidate;
  for (let attempt = 0; attempt < 1000 && Date.parse(next) <= Date.parse(now); attempt += 1) {
    const advanced = computeNextWorkflowFireAt(trigger, next, now);
    if (!advanced || advanced === next) return null;
    next = advanced;
  }
  return next;
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

function releaseTrigger(trigger: WorkflowTriggerRecord, workerId: string, now: string, nextFireAt: string | null, status?: string, lastFireAt?: string): void {
  advanceWorkflowTriggerSync({ id: trigger.id, workspaceId: trigger.workspaceId, workerId, nextFireAt, lastFireAt, status, now });
}
