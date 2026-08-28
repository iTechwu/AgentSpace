import assert from "node:assert/strict";
import test from "node:test";
import {
  isQualityReportPassing,
  parseQualityReport,
  parseQualityReportArtifactEnvelope,
  parseSkillArtifactRevision,
} from "./skill-production.ts";

test("parseSkillArtifactRevision accepts a valid revision and rejects malformed input", () => {
  const revision = parseSkillArtifactRevision({
    artifactId: "script",
    revision: "r2",
    digest: "abc123",
    producedBy: "novel-script",
    inputRefs: ["digest-a", "digest-b"],
    schemaVersion: 1,
  });
  assert.deepEqual(revision, {
    artifactId: "script",
    revision: "r2",
    digest: "abc123",
    producedBy: "novel-script",
    inputRefs: ["digest-a", "digest-b"],
    schemaVersion: 1,
  });

  assert.equal(parseSkillArtifactRevision(null), null);
  assert.equal(parseSkillArtifactRevision({ artifactId: "", revision: "r1", digest: "d", producedBy: "p", inputRefs: [], schemaVersion: 1 }), null);
  assert.equal(parseSkillArtifactRevision({ artifactId: "cast", revision: "r1", digest: "d", producedBy: "p", inputRefs: ["ok", 1], schemaVersion: 1 }), null);
  assert.equal(parseSkillArtifactRevision({ artifactId: "cast", revision: "r1", digest: "d", producedBy: "p", inputRefs: [], schemaVersion: 0 }), null);
});

test("parseQualityReport accepts a valid report and rejects malformed input", () => {
  const report = parseQualityReport({
    schemaVersion: 1,
    subject: { artifactId: "script", revision: "r2", digest: "abc" },
    checks: [
      { id: "cross-cast-consistency", status: "pass" },
      { id: "cross-scene-consistency", status: "block", detail: "missing scene" },
    ],
    blockingCount: 1,
    maxRounds: 3,
    round: 2,
  });
  assert.ok(report);
  assert.equal(report.checks.length, 2);
  assert.equal(report.blockingCount, 1);

  assert.equal(parseQualityReport(null), null);
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: {}, checks: [], blockingCount: 0, maxRounds: 3, round: 1 }), null, "subject missing fields");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: " ", revision: "r1", digest: "d" }, checks: [], blockingCount: 0, maxRounds: 3, round: 1 }), null, "blank subject artifact");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [{ id: "x", status: "unknown" }], blockingCount: 0, maxRounds: 3, round: 1 }), null, "invalid check status");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [{ id: "x", status: "pass" }, { id: "x", status: "pass" }], blockingCount: 0, maxRounds: 3, round: 1 }), null, "duplicate check id");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [], blockingCount: -1, maxRounds: 3, round: 1 }), null, "negative blockingCount");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [], blockingCount: 0.5, maxRounds: 3, round: 1 }), null, "fractional blockingCount");
  assert.equal(parseQualityReport({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [], blockingCount: 0, maxRounds: 3, round: 4 }), null, "round exceeds maxRounds");
});

test("isQualityReportPassing is fail-closed and consistent", () => {
  assert.equal(isQualityReportPassing({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [], blockingCount: 0, maxRounds: 3, round: 1 }), true);
  assert.equal(isQualityReportPassing({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [{ id: "x", status: "block" }], blockingCount: 1, maxRounds: 3, round: 1 }), false);
  // Declared blockingCount disagrees with the checks (0 declared, 1 actual block) → fail-closed.
  assert.equal(isQualityReportPassing({ schemaVersion: 1, subject: { artifactId: "s", revision: "r1", digest: "d" }, checks: [{ id: "x", status: "block" }], blockingCount: 0, maxRounds: 3, round: 1 }), false);
});

test("parseQualityReportArtifactEnvelope binds digest and workspace to a complete report", () => {
  const report = { schemaVersion: 1, subject: { artifactId: "script", revision: "r2", digest: "artifact-digest" }, checks: [], blockingCount: 0, maxRounds: 2, round: 1 };
  const envelope = parseQualityReportArtifactEnvelope({
    kind: "quality-report",
    digest: "qr-1",
    workspaceId: "workspace-1",
    report,
  }, "qr-1", "workspace-1");
  assert.deepEqual(envelope?.report, report);
  assert.equal(parseQualityReportArtifactEnvelope({ kind: "quality-report", digest: "qr-2", workspaceId: "workspace-1", report }, "qr-1", "workspace-1"), null);
  assert.equal(parseQualityReportArtifactEnvelope({ kind: "quality-report", digest: "qr-1", workspaceId: "workspace-2", report }, "qr-1", "workspace-1"), null);
  assert.equal(parseQualityReportArtifactEnvelope({ kind: "quality-report", digest: "qr-1", workspaceId: "workspace-1", report: { ...report, blockingCount: -1 } }, "qr-1", "workspace-1"), null);
});
