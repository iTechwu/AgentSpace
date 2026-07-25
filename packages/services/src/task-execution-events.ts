import {
  listTaskExecutionEventsSync as listDbTaskExecutionEventsSync,
  recordTaskExecutionEventSync as recordDbTaskExecutionEventSync,
  type TaskExecutionEventInput,
  type TaskExecutionEventListOptions,
  type TaskExecutionEventRecord,
} from "@dofe-agent/db";
import { publishTaskExecutionEventCreatedEvent } from "./realtime/events.ts";

export function recordTaskExecutionEventSync(input: TaskExecutionEventInput): TaskExecutionEventRecord {
  const event = recordDbTaskExecutionEventSync(input);
  publishTaskExecutionEventCreatedEvent({
    workspaceId: event.workspaceId,
    channelName: event.channelName,
    taskId: event.taskId,
    eventId: event.id,
    createdAt: event.createdAt,
  });
  return event;
}

export function listTaskExecutionEventsSync(
  options: TaskExecutionEventListOptions = {},
): TaskExecutionEventRecord[] {
  return listDbTaskExecutionEventsSync(options);
}

export type { TaskExecutionEventInput, TaskExecutionEventListOptions, TaskExecutionEventRecord };
