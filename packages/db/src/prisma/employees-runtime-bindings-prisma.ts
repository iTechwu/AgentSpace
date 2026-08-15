// employees-runtime-bindings Phase 2 真 Prisma Client primary：与 audit-log /
// notifications / task-execution-events / workspace-memberships 同款双 runner
// 模式，pg 原型 runner 仅作迁移期 fallback（见同目录 -async.ts 顶部）。

import { PrismaClient } from "@prisma/client";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";

let cachedClient: PrismaClient | null = null;
function getPrismaClient(): PrismaClient {
  if (cachedClient) return cachedClient;
  cachedClient = new PrismaClient();
  return cachedClient;
}

export function setEmployeesRuntimeBindingsPrismaClientForTests(
  client: PrismaClient | null,
): void {
  cachedClient = client;
}

interface PrismaBinding {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  runtimeId: string;
  provider: string;
  runtimeName: string;
  status: string;
  generation: number;
  desiredProvider: string | null;
  boundAt: Date;
  updatedAt: Date;
}

export async function listEmployeeRuntimeBindingsPrisma(
  workspaceId: string,
  client?: PrismaClient,
): Promise<EmployeeRuntimeBindingRecord[]> {
  const prisma = client ?? getPrismaClient();
  // The Prisma schema for this PR uses EmployeeRuntimeBinding as a flat
  // projection; the runtime JOIN is collapsed here because Prisma's
  // generated model does not have an explicit `agentRuntime` relation.
  // Domain callers receive the same shape the sync listEmployeeRuntimeBindingsSync
  // produces.
  const rows = await prisma.employeeRuntimeBinding.findMany({
    where: { workspaceId },
    orderBy: { employeeName: "asc" },
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaBinding));
}

export function isEmployeesRuntimeBindingsPrismaReadEnabled(): boolean {
  return process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED === "1";
}

export function isEmployeesRuntimeBindingsPrismaShadowReadEnabled(): boolean {
  return process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export async function disconnectEmployeesRuntimeBindingsPrismaForTests(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = null;
  }
}

function mapPrismaRow(row: PrismaBinding): EmployeeRuntimeBindingRecord {
  const record: EmployeeRuntimeBindingRecord = {
    workspaceId: row.workspaceId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    runtimeId: row.runtimeId,
    provider: row.provider as EmployeeRuntimeBindingRecord["provider"],
    runtimeName: row.runtimeName,
    status: row.status as EmployeeRuntimeBindingRecord["status"],
    generation: row.generation,
    boundAt: row.boundAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.desiredProvider !== null) record.desiredProvider = row.desiredProvider;
  return record;
}