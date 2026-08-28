import { createHmac } from "node:crypto";

export interface SkillInstallationDiagnosticsInput {
  generatedAt: string;
  referenceSalt: Uint8Array;
  workspaceId: string;
  skillId: string;
  artifacts: Array<{
    digest: string;
    version: string;
    sourceType: string;
    fileCount: number;
    totalSizeBytes: number;
  }>;
  installations: Array<{
    id: string;
    runtimeId: string;
    artifactDigest: string;
    status: string;
    revision: string;
    health: string;
    releaseLockDigest?: string;
    preparedDigest?: string;
    createdAt: string;
    components: Array<{
      kind: string;
      key: string;
      status: string;
      errorCode?: string;
      errorMessage?: string;
    }>;
    operations: Array<{
      id: string;
      operation: string;
      status: string;
      claimGeneration: number;
      errorCode?: string;
      errorMessage?: string;
      createdAt: string;
      evidence?: { computedDigest?: string; cacheHit?: boolean; installedDependencyCount?: number };
    }>;
  }>;
  approvals: Array<{
    id: string;
    artifactDigest: string;
    releaseLockDigest: string;
    policyVersion: string;
    decision: string;
    riskItems: Array<{ category: string; key: string; description?: string }>;
    reason?: string;
    actorUserId?: string;
    createdAt: string;
    consumedAt?: string;
  }>;
  invocations: Array<{
    id: string;
    installationId?: string;
    runtimeId?: string;
    artifactDigest: string;
    entrypointKey: string;
    resultCode: number;
    timedOut: boolean;
    durationMs?: number;
    safeSummary?: string;
    taskId?: string;
    actorId: string;
    createdAt: string;
  }>;
}

export function buildSkillInstallationDiagnostics(input: SkillInstallationDiagnosticsInput) {
  const reference = (kind: string, value: string | undefined): string | undefined => {
    if (!value) return undefined;
    return `${kind}_${createHmac("sha256", input.referenceSalt).update(value).digest("hex").slice(0, 16)}`;
  };

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    redaction: {
      identifierStrategy: "per-export salted HMAC references",
      omittedFields: [
        "error messages",
        "approval reasons and actors",
        "task and user identifiers",
        "runner summaries",
        "source URLs and filesystem paths",
        "configuration and secret values",
      ],
    },
    workspaceRef: reference("workspace", input.workspaceId),
    skillRef: reference("skill", input.skillId),
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
    installations: input.installations.map((installation) => ({
      installationRef: reference("installation", installation.id),
      runtimeRef: reference("runtime", installation.runtimeId),
      artifactDigest: installation.artifactDigest,
      status: installation.status,
      revision: installation.revision,
      health: installation.health,
      releaseLockDigest: installation.releaseLockDigest,
      preparedDigest: installation.preparedDigest,
      createdAt: installation.createdAt,
      components: installation.components.map((component) => ({
        kind: component.kind,
        key: component.key,
        status: component.status,
        errorCode: component.errorCode,
      })),
      operations: installation.operations.map((operation) => ({
        operationRef: reference("operation", operation.id),
        operation: operation.operation,
        status: operation.status,
        claimGeneration: operation.claimGeneration,
        errorCode: operation.errorCode,
        createdAt: operation.createdAt,
        evidence: operation.evidence,
      })),
    })),
    approvals: input.approvals.map((approval) => ({
      approvalRef: reference("approval", approval.id),
      artifactDigest: approval.artifactDigest,
      releaseLockDigest: approval.releaseLockDigest,
      policyVersion: approval.policyVersion,
      decision: approval.decision,
      riskItems: approval.riskItems.map((item) => ({ category: item.category, key: item.key })),
      createdAt: approval.createdAt,
      consumedAt: approval.consumedAt,
    })),
    invocations: input.invocations.map((invocation) => ({
      invocationRef: reference("invocation", invocation.id),
      installationRef: reference("installation", invocation.installationId),
      runtimeRef: reference("runtime", invocation.runtimeId),
      artifactDigest: invocation.artifactDigest,
      entrypointKey: invocation.entrypointKey,
      resultCode: invocation.resultCode,
      timedOut: invocation.timedOut,
      durationMs: invocation.durationMs,
      createdAt: invocation.createdAt,
    })),
  };
}
