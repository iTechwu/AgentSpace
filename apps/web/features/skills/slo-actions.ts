"use server";

import { evaluateDataProtectionHealthSync } from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";

export interface DataProtectionSloView {
  metrics: {
    workspaceHeadAgeSeconds: number;
    skillArtifactVerificationFailures: number;
    runtimeBindingGenerationConflicts: number;
    taskCommitReconciliationBacklog: number;
    runtimeRecoveryDurationSeconds: number;
    employeeDataUsageBytes: number;
    retentionQuotaExceededEmployees: number;
    activeLegalHolds: number;
  };
  alerts: Array<{ code: string; severity: string; message: string; employeeName?: string }>;
  checkedAt: string;
  /** SLO targets the health check enforces. */
  sloTargets: {
    headAgeSeconds: number;
    recoveryRtoSeconds: number;
  };
}

/** 数据保护 SLO 看板（P1-6）：head age / 恢复时长 / digest 失败 / 绑定冲突 / 容量 / RPO·RTO。 */
export async function readDataProtectionSloDashboardAction(): Promise<DataProtectionSloView> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const health = evaluateDataProtectionHealthSync({ workspaceId: workspaceContext.currentWorkspace.id });
  return {
    metrics: {
      workspaceHeadAgeSeconds: health.metrics.workspaceHeadAgeSeconds,
      skillArtifactVerificationFailures: health.metrics.skillArtifactVerificationFailures,
      runtimeBindingGenerationConflicts: health.metrics.runtimeBindingGenerationConflicts,
      taskCommitReconciliationBacklog: health.metrics.taskCommitReconciliationBacklog,
      runtimeRecoveryDurationSeconds: health.metrics.runtimeRecoveryDurationSeconds,
      employeeDataUsageBytes: health.metrics.employeeDataUsageBytes,
      retentionQuotaExceededEmployees: health.metrics.retentionQuotaExceededEmployees,
      activeLegalHolds: health.metrics.activeLegalHolds,
    },
    alerts: health.alerts.map((alert) => ({
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      employeeName: alert.employeeName,
    })),
    checkedAt: health.checkedAt,
    sloTargets: { headAgeSeconds: 7 * 24 * 3600, recoveryRtoSeconds: 3600 },
  };
}
