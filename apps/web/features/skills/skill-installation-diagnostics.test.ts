import { describe, expect, it } from "vitest";
import { buildSkillInstallationDiagnostics } from "./skill-installation-diagnostics";

describe("buildSkillInstallationDiagnostics", () => {
  it("keeps operational evidence while structurally omitting sensitive text and identifiers", () => {
    const bundle = buildSkillInstallationDiagnostics({
      generatedAt: "2026-08-03T12:00:00.000Z",
      referenceSalt: new Uint8Array(32).fill(7),
      workspaceId: "workspace-secret-id",
      skillId: "skill-secret-id",
      artifacts: [{ digest: "a".repeat(64), version: "1.0.0", sourceType: "github", fileCount: 2, totalSizeBytes: 128 }],
      installations: [{
        id: "installation-secret-id",
        runtimeId: "runtime-secret-id",
        artifactDigest: "a".repeat(64),
        status: "blocked",
        revision: "v1",
        health: "unhealthy",
        createdAt: "2026-08-03T10:00:00.000Z",
        components: [{ kind: "service", key: "search", status: "failed", errorCode: "health.failed", errorMessage: "Bearer raw-secret-token" }],
        operations: [{
          id: "operation-secret-id",
          operation: "install",
          status: "failed",
          claimGeneration: 2,
          errorCode: "install.failed",
          errorMessage: "PASSWORD=raw-password",
          createdAt: "2026-08-03T10:01:00.000Z",
          evidence: { cacheHit: false, installedDependencyCount: 3 },
        }],
      }],
      approvals: [{
        id: "approval-secret-id",
        artifactDigest: "a".repeat(64),
        releaseLockDigest: "b".repeat(64),
        policyVersion: "v1",
        decision: "approved",
        riskItems: [{ category: "network", key: "api.example.test", description: "private description" }],
        reason: "approved with token=raw-token",
        actorUserId: "user-secret-id",
        createdAt: "2026-08-03T09:00:00.000Z",
      }],
      invocations: [{
        id: "invocation-secret-id",
        installationId: "installation-secret-id",
        runtimeId: "runtime-secret-id",
        artifactDigest: "a".repeat(64),
        entrypointKey: "render",
        resultCode: 1,
        timedOut: false,
        safeSummary: "api_key=raw-key",
        taskId: "task-secret-id",
        actorId: "user-secret-id",
        createdAt: "2026-08-03T11:00:00.000Z",
      }],
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("raw-");
    expect(serialized).not.toContain("secret-id");
    expect(serialized).not.toContain("private description");
    expect(bundle.installations[0]?.components[0]?.errorCode).toBe("health.failed");
    expect(bundle.installations[0]?.operations[0]?.evidence).toEqual({ cacheHit: false, installedDependencyCount: 3 });
    expect(bundle.installations[0]?.installationRef).toMatch(/^installation_[a-f0-9]{16}$/);
    expect(bundle.installations[0]?.runtimeRef).toBe(bundle.invocations[0]?.runtimeRef);
  });
});
