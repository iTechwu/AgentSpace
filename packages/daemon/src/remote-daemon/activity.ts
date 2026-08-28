// 3.5-4：自 remote-daemon.ts 拆出——runtime 并发/独占活动跟踪（纯状态，无 IO）。

export interface RemoteRuntimeActivity {
  exclusiveRuntimes: Set<string>;
  taskCounts: Map<string, number>;
  /** 3.5-8：runtime → 下一次允许进入操作队列 claim 级联的时间戳（epoch ms）。 */
  nextOperationClaimAt: Map<string, number>;
}

export function createRemoteRuntimeActivity(): RemoteRuntimeActivity {
  return {
    exclusiveRuntimes: new Set<string>(),
    taskCounts: new Map<string, number>(),
    nextOperationClaimAt: new Map<string, number>(),
  };
}

export function beginRemoteRuntimeTask(activity: RemoteRuntimeActivity, runtimeId: string): boolean {
  if (activity.exclusiveRuntimes.has(runtimeId)) return false;
  const current = activity.taskCounts.get(runtimeId) ?? 0;
  activity.taskCounts.set(runtimeId, current + 1);
  return true;
}

export function endRemoteRuntimeTask(activity: RemoteRuntimeActivity, runtimeId: string): void {
  const current = activity.taskCounts.get(runtimeId) ?? 0;
  if (current <= 1) {
    activity.taskCounts.delete(runtimeId);
    return;
  }
  activity.taskCounts.set(runtimeId, current - 1);
}

export function reserveRemoteRuntimeExclusiveSlot(activity: RemoteRuntimeActivity, runtimeId: string): boolean {
  if (activity.exclusiveRuntimes.has(runtimeId) || (activity.taskCounts.get(runtimeId) ?? 0) > 0) return false;
  activity.exclusiveRuntimes.add(runtimeId);
  return true;
}

export function releaseRemoteRuntimeExclusiveSlot(activity: RemoteRuntimeActivity, runtimeId: string): void {
  activity.exclusiveRuntimes.delete(runtimeId);
}
