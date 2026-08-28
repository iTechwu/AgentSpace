// employees-runtime-bindings Phase 2 真 Prisma Client primary：与 audit-log /
// notifications / task-execution-events / workspace-memberships 同款双 runner
// 模式，pg 原型 runner 仅作迁移期 fallback（见同目录 -async.ts 顶部）。

import type { PrismaClient } from "@prisma/client";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";

export function setEmployeesRuntimeBindingsPrismaClientForTests(
  client: PrismaClient | null,
): void {
  setDofePrismaClientForTests(client);
}

interface PrismaBinding {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  runtimeId: string;
  runtime: {
    provider: string;
    name: string;
  };
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
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.employeeRuntimeBinding.findMany({
    where: { workspaceId },
    orderBy: { employeeName: "asc" },
    include: {
      runtime: {
        select: { provider: true, name: true },
      },
    },
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
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaBinding): EmployeeRuntimeBindingRecord {
  const record: EmployeeRuntimeBindingRecord = {
    workspaceId: row.workspaceId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    runtimeId: row.runtimeId,
    provider: row.runtime.provider as EmployeeRuntimeBindingRecord["provider"],
    runtimeName: row.runtime.name,
    status: row.status as EmployeeRuntimeBindingRecord["status"],
    generation: row.generation,
    boundAt: row.boundAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.desiredProvider !== null) record.desiredProvider = row.desiredProvider;
  return record;
}
