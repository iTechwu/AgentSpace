import {
  advanceWorkflowTriggerSync,
  claimDueWorkflowTriggersSync,
  type WorkflowTriggerRecord,
} from "@dofe-agent/db";
import { materializeWorkflowRunSync } from "./materialization.ts";

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
    const next = computeNextWorkflowFireAt(trigger, scheduledAt, input.now);
    if (!next) {
      releaseTrigger(trigger, input.workerId, input.now, null, "paused");
      result.misfiredTriggerIds.push(trigger.id);
      continue;
    }
    const misfired = trigger.misfirePolicy === "skip" && Date.parse(next) <= Date.parse(input.now);
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
      releaseTrigger(trigger, input.workerId, input.now, next, undefined, scheduledAt);
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
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(trigger.configJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const repeatSeconds = Number(config.repeatSeconds ?? config.intervalSeconds);
  if (Number.isFinite(repeatSeconds) && repeatSeconds > 0) {
    return new Date(Date.parse(scheduledAt) + repeatSeconds * 1000).toISOString();
  }
  const dailyAt = typeof config.dailyAt === "string" ? config.dailyAt : undefined;
  if (dailyAt) return nextDailyAt(scheduledAt, dailyAt, trigger.timezone ?? "UTC");
  return null;
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
