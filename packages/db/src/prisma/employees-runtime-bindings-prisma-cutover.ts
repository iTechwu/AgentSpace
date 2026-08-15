// employees-runtime-bindings read cutover runner（真 Prisma Client primary）：
// Phase 2 五域 pilot 的生产路径。pg 原型同款 runner 见
// employees-runtime-bindings-cutover.ts（标 @deprecated）。

import { listEmployeeRuntimeBindingsSync } from "../employee-bindings.ts";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";
import {
  isEmployeesRuntimeBindingsPrismaReadEnabled,
  isEmployeesRuntimeBindingsPrismaShadowReadEnabled,
  listEmployeeRuntimeBindingsPrisma,
  setEmployeesRuntimeBindingsPrismaClientForTests,
} from "./employees-runtime-bindings-prisma.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListEmployeesRuntimeBindingsPrismaCutoverMetric = ReadCutoverMetric;
export type ListEmployeesRuntimeBindingsPrismaCutoverMetricSink = (
  metric: ListEmployeesRuntimeBindingsPrismaCutoverMetric,
) => void;

const listEmployeeRuntimeBindingsPrismaCutoverImpl = buildDomainCutover<
  string,
  EmployeeRuntimeBindingRecord[],
  ListEmployeesRuntimeBindingsPrismaCutoverMetric
>({
  isEnabled: isEmployeesRuntimeBindingsPrismaReadEnabled,
  isShadowEnabled: isEmployeesRuntimeBindingsPrismaShadowReadEnabled,
  runPrimary: async (workspaceId) => listEmployeeRuntimeBindingsPrisma(workspaceId),
  runFallback: (workspaceId) => listEmployeeRuntimeBindingsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

export function listEmployeeRuntimeBindingsPrismaCutover(
  workspaceId: string,
  metricSink?: ListEmployeesRuntimeBindingsPrismaCutoverMetricSink,
): Promise<EmployeeRuntimeBindingRecord[]> {
  return listEmployeeRuntimeBindingsPrismaCutoverImpl(workspaceId, metricSink);
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

const _ensureSetterExport: typeof setEmployeesRuntimeBindingsPrismaClientForTests | undefined = undefined;
void _ensureSetterExport;