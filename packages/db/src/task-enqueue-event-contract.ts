export type TaskEnqueueLifecycleEvent =
  | { stream: "router"; type: "task_queued" }
  | { stream: "queue"; type: "queued" };

/** The lifecycle sequence emitted by the legacy task enqueue implementation. */
export const LEGACY_TASK_ENQUEUE_EVENT_ORDER = [
  { stream: "router", type: "task_queued" },
  { stream: "queue", type: "queued" },
] as const satisfies readonly TaskEnqueueLifecycleEvent[];

export interface EventOrderObservation {
  comparedCount: number;
  driftCount: number;
}

export interface WorkflowDispatchObservability {
  eventOrder: EventOrderObservation;
}

export function observeLegacyTaskEnqueueEventOrder(
  observed: readonly TaskEnqueueLifecycleEvent[],
): EventOrderObservation {
  const matches = observed.length === LEGACY_TASK_ENQUEUE_EVENT_ORDER.length
    && observed.every((event, index) => {
      const expected = LEGACY_TASK_ENQUEUE_EVENT_ORDER[index];
      return event.stream === expected?.stream && event.type === expected.type;
    });
  return { comparedCount: 1, driftCount: matches ? 0 : 1 };
}
