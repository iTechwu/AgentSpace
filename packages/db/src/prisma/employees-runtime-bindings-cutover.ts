// @deprecated — Phase 2 五域 pilot 的 pg 原型 cutover runner。
// 生产路径走 employees-runtime-bindings-prisma-cutover.ts。
// 详见 employees-runtime-bindings-async.ts 顶部。

import { listEmployeeRuntimeBindingsSync } from "../employee-bindings.ts";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";
import {
  isEmployeesRuntimeBindingsAsyncReadEnabled,
  isEmployeesRuntimeBindingsShadowReadEnabled,
  listEmployeeRuntimeBindingsAsync,
} from "./employees-runtime-bindings-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListEmployeesRuntimeBindingsCutoverMetric = ReadCutoverMetric;
export type ListEmployeesRuntimeBindingsCutoverMetricSink = (
  metric: ListEmployeesRuntimeBindingsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listEmployeeRuntimeBindingsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listEmployeeRuntimeBindingsCutover(
  workspaceId: string,
  metricSink?: ListEmployeesRuntimeBindingsCutoverMetricSink,
): Promise<EmployeeRuntimeBindingRecord[]> {
  return buildDomainCutover<
    string,
    EmployeeRuntimeBindingRecord[],
    ListEmployeesRuntimeBindingsCutoverMetric
  >({
    isEnabled: isEmployeesRuntimeBindingsAsyncReadEnabled,
    isShadowEnabled: isEmployeesRuntimeBindingsShadowReadEnabled,
    runPrimary: async (id) => listEmployeeRuntimeBindingsAsync(id),
    runFallback: (id) => listEmployeeRuntimeBindingsSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
}

export function recordsEqual(
  primary: EmployeeRuntimeBindingRecord[],
  fallback: EmployeeRuntimeBindingRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: EmployeeRuntimeBindingRecord,
  fallback: EmployeeRuntimeBindingRecord,
): boolean {
  return (
    primary.workspaceId === fallback.workspaceId &&
    primary.employeeId === fallback.employeeId &&
    primary.employeeName === fallback.employeeName &&
    primary.runtimeId === fallback.runtimeId &&
    primary.provider === fallback.provider &&
    primary.runtimeName === fallback.runtimeName &&
    primary.status === fallback.status &&
    primary.generation === fallback.generation &&
    primary.desiredProvider === fallback.desiredProvider &&
    primary.boundAt === fallback.boundAt &&
    primary.updatedAt === fallback.updatedAt
  );
}