export const QUALITY_REPORT_SCHEMA_VERSION = 1;

/**
 * The immutable revision contract for a production artifact (cast/art/script/
 * storyboard): every round publishes a revision the convergence group can
 * consume and re-validate. `digest` is the artifact content digest; `inputRefs`
 * are the digests of the frozen inputs it was produced from.
 */
export interface SkillArtifactRevision {
  artifactId: string;
  revision: string;
  digest: string;
  producedBy: string;
  inputRefs: string[];
  schemaVersion: number;
}

export interface QualityReportCheck {
  id: string;
  status: "pass" | "block";
  detail?: string;
}

/**
 * The unified quality-gate result. `blockingCount` is the authoritative
 * "still has N blocking items" signal; `round`/`maxRounds` bound the
 * convergence loop. Nodes return only the digest + a summary — the full
 * report travels through the artifact manifest (256 KB output channel).
 */
export interface QualityReport {
  schemaVersion: number;
  subject: { artifactId: string; revision: string; digest: string };
  checks: QualityReportCheck[];
  blockingCount: number;
  maxRounds: number;
  round: number;
}

export function parseSkillArtifactRevision(value: unknown): SkillArtifactRevision | null {
  if (!isRecord(value)) return null;
  if (typeof value.artifactId !== "string" || value.artifactId.trim() === "") return null;
  if (typeof value.revision !== "string" || value.revision.trim() === "") return null;
  if (typeof value.digest !== "string" || value.digest.trim() === "") return null;
  if (typeof value.producedBy !== "string" || value.producedBy.trim() === "") return null;
  if (!Array.isArray(value.inputRefs) || !value.inputRefs.every((ref) => typeof ref === "string")) return null;
  if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1) return null;
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    digest: value.digest,
    producedBy: value.producedBy,
    inputRefs: value.inputRefs as string[],
    schemaVersion: value.schemaVersion,
  };
}

export function parseQualityReport(value: unknown): QualityReport | null {
  if (!isRecord(value)) return null;
  if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1) return null;
  const subject = value.subject;
  if (!isRecord(subject)) return null;
  if (
    typeof subject.artifactId !== "string"
    || typeof subject.revision !== "string"
    || typeof subject.digest !== "string"
  ) return null;
  if (!Array.isArray(value.checks)) return null;
  const checks: QualityReportCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check)) return null;
    if (typeof check.id !== "string" || check.id.trim() === "") return null;
    if (check.status !== "pass" && check.status !== "block") return null;
    if (check.detail !== undefined && typeof check.detail !== "string") return null;
    checks.push({
      id: check.id,
      status: check.status,
      ...(typeof check.detail === "string" && check.detail !== "" ? { detail: check.detail } : {}),
    });
  }
  if (typeof value.blockingCount !== "number" || value.blockingCount < 0) return null;
  if (typeof value.maxRounds !== "number" || value.maxRounds < 1) return null;
  if (typeof value.round !== "number" || value.round < 1) return null;
  return {
    schemaVersion: value.schemaVersion,
    subject: {
      artifactId: subject.artifactId as string,
      revision: subject.revision as string,
      digest: subject.digest as string,
    },
    checks,
    blockingCount: value.blockingCount,
    maxRounds: value.maxRounds,
    round: value.round,
  };
}

/**
 * A quality gate passes only when the DECLARED blockingCount is zero AND no
 * check actually blocks — a report whose declared count disagrees with its
 * checks is treated as not passing (fail-closed).
 */
export function isQualityReportPassing(report: QualityReport): boolean {
  const actualBlocking = report.checks.filter((check) => check.status === "block").length;
  return report.blockingCount === 0 && actualBlocking === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
