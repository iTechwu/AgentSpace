// @deprecated — Phase 2 五域 pilot，pg 直连原型仅作 Prisma 接入迁移期
// fallback。生产路径走 employees-runtime-bindings-prisma.ts（同等接口，
// @prisma/client 真接入）。本文件保留以：
// 1. 在 Prisma 接入回退时提供 fallback；
// 2. 旧 PG 切流 flag（EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED=1）
//    仍可触发影子对比，验证迁移期一致性。
// 迁移完成（Prisma runner 全量生产化 + 影子对比零漂移 ≥ 30 天）后
// 删除本文件。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";

const VALID_STATUSES = new Set([
  "online",
  "degraded",
  "offline",
  "recovering",
  "needs_attention",
]);

export async function listEmployeeRuntimeBindingsAsync(
  workspaceId: string,
): Promise<EmployeeRuntimeBindingRecord[]> {
  const sql = `SELECT
                erb.workspace_id   AS "workspaceId",
                erb.employee_id    AS "employeeId",
                erb.employee_name  AS "employeeName",
                erb.runtime_id     AS "runtimeId",
                ar.provider        AS provider,
                ar.name            AS "runtimeName",
                erb.status         AS status,
                erb.generation     AS generation,
                erb.desired_provider AS "desiredProvider",
                erb.created_at     AS "boundAt",
                erb.updated_at     AS "updatedAt"
              FROM employee_runtime_binding erb
              JOIN agent_runtime ar ON ar.id = erb.runtime_id
              WHERE erb.workspace_id = $1
              ORDER BY erb.employee_name ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow).filter((r): r is EmployeeRuntimeBindingRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isEmployeesRuntimeBindingsAsyncReadEnabled(): boolean {
  return process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED === "1";
}

export function isEmployeesRuntimeBindingsShadowReadEnabled(): boolean {
  return process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  runtimeId: string;
  provider: string;
  runtimeName: string;
  status: string;
  generation: number;
  desiredProvider: string | null;
  boundAt: Date | string;
  updatedAt: Date | string;
}

function mapRow(row: RawRow): EmployeeRuntimeBindingRecord | null {
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: EmployeeRuntimeBindingRecord = {
    workspaceId: row.workspaceId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    runtimeId: row.runtimeId,
    provider: row.provider as EmployeeRuntimeBindingRecord["provider"],
    runtimeName: row.runtimeName,
    status: row.status as EmployeeRuntimeBindingRecord["status"],
    generation: row.generation,
    boundAt: toIsoString(row.boundAt),
    updatedAt: toIsoString(row.updatedAt),
  };
  if (row.desiredProvider !== null) record.desiredProvider = row.desiredProvider;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
