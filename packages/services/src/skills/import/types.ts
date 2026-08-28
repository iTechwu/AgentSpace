// 技能导入的导入类型与预算常量（从 src/skills/import.ts 拆出，3.6 巨型文件项）。


export type SkillImportConflict = "reject" | "rename" | "replace" | "skip";
export type SkillImportSourceType = "github" | "gitlab" | "skills.sh" | "clawhub" | "local" | "tos";

/**
 * Stable product-facing error codes for GitHub skill imports
 * (docs/0801/skill-install/14 §Implementation Decisions). The Web layer maps
 * each code to a localized message + remedy instead of showing the raw
 * internal English exception.
 */
export type SkillGitHubImportErrorCode =
  | "skill.github.url_invalid"
  | "skill.github.not_found"
  | "skill.github.no_skill"
  | "skill.github.multiple_skills"
  | "skill.github.tree_truncated"
  | "skill.github.rate_limited"
  | "skill.github.unauthorized"
  | "skill.github.file_download_failed"
  | "skill.github.unavailable";

/** A GitHub import failure carrying a stable {@link SkillGitHubImportErrorCode} plus structured payloads for the UI. */
export class SkillGitHubImportError extends Error {
  readonly code: SkillGitHubImportErrorCode;
  /** Candidate skill directories (multiple_skills) — the user picks one or pastes its tree URL. "" means the repository root. */
  readonly candidates?: string[];
  /** Epoch seconds when the shared GitHub API quota resets (rate_limited). */
  readonly retryAtEpochSeconds?: number;

  constructor(
    code: SkillGitHubImportErrorCode,
    message: string,
    options?: { candidates?: string[]; retryAtEpochSeconds?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "SkillGitHubImportError";
    this.code = code;
    if (options?.candidates) this.candidates = options.candidates;
    if (options?.retryAtEpochSeconds !== undefined) this.retryAtEpochSeconds = options.retryAtEpochSeconds;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Maps a failed GitHub API response onto the stable product error codes (auth / quota / existence / availability). */
export function skillGitHubHttpError(response: Response, context: string): SkillGitHubImportError {
  if (response.status === 404) {
    return new SkillGitHubImportError(
      "skill.github.not_found",
      `${context}: repository, ref, or path not found (HTTP 404).`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    // GitHub answers quota exhaustion as 403 with X-RateLimit-Remaining: 0 —
    // that is a retryable availability state, distinct from a bad credential.
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const resetHeader = Number(response.headers.get("x-ratelimit-reset"));
      return new SkillGitHubImportError(
        "skill.github.rate_limited",
        `${context}: GitHub API rate limit exhausted (HTTP ${response.status}).`,
        Number.isSafeInteger(resetHeader) && resetHeader > 0 ? { retryAtEpochSeconds: resetHeader } : undefined,
      );
    }
    return new SkillGitHubImportError(
      "skill.github.unauthorized",
      `${context}: credentials lack access (HTTP ${response.status}).`,
    );
  }
  return new SkillGitHubImportError(
    "skill.github.unavailable",
    `${context}: GitHub API unavailable (HTTP ${response.status}).`,
  );
}
export interface SkillImportResult {
  skillId: string;
  skillName: string;
  sourceUrl: string;
  created: boolean;
  renamed: boolean;
  replaced: boolean;
  skipped: boolean;
  sourceType: SkillImportSourceType;
  requiresConfiguration: boolean;
  /** Immutable imported artifact digest. On replace this is a candidate until explicitly promoted. */
  artifactDigest?: string;
  /** Resolved skill directory inside the repository ("" = repository root; GitHub/GitLab imports). */
  resolvedPath?: string;
  /** Immutable commit SHA the import was locked to (GitHub/GitLab imports). */
  resolvedRef?: string;
  warnings: string[];
}
export type SkillSourceUpdateStatus =
  | "up_to_date"
  | "update_available"
  | "disabled"
  | "unsupported"
  | "not_checkable";
export interface SkillSourceUpdateInspection {
  skillId: string;
  sourceType?: string;
  sourceUrl?: string;
  status: SkillSourceUpdateStatus;
  currentResolvedRef?: string;
  latestResolvedRef?: string;
  reason?: string;
}

/**
 * An imported file carried as raw bytes (binary-safe). Text files additionally
 * decode to a UTF-8 string for the legacy text projection (skill_file); binary
 * files live only in the immutable artifact + content-addressed blob store.
 */
export interface ImportedSkillFile {
  path: string;
  bytes: Uint8Array;
  mode?: string;
}
export interface SkillSourceBudget {
  fileCount: number;
  totalBytes: number;
  requestCount: number;
}
export const MAX_SKILL_SOURCE_REQUESTS = 256;
export const GITHUB_RAW_DOWNLOAD_CONCURRENCY = 4;
export const GITHUB_RAW_DOWNLOAD_TIMEOUT_MS = 5_000;
export const MAX_SKILL_SOURCE_METADATA_BYTES = 2 * 1024 * 1024;
export interface ImportedSkillDefinition {
  name: string;
  description: string;
  files: ImportedSkillFile[];
  sourceType: SkillImportSourceType;
  sourceUrl: string;
  configJson: string;
  warnings: string[];
  /** Immutable commit SHA / registry digest; execution and audit must use this. */
  resolvedRef?: string;
  /** Resolved skill directory inside the repository ("" = repository root). */
  resolvedPath?: string;
  /** Original user-submitted URL (mutable branch/tag allowed here). */
  originalUrl?: string;
}
export interface GitHubDirectoryPointer {
  owner: string;
  repo: string;
  /** Original branch/tag/ref from the user URL. */
  ref: string;
  path: string;
  /** Immutable commit SHA resolved from `ref` before any content fetch. */
  resolvedSha?: string;
  /** Immutable tree entries captured while discovering a repository-root URL. */
  discoveredFiles?: Array<{ path: string; mode?: string; sha?: string; size?: number }>;
  /** API requests already spent resolving a repository-root URL. */
  discoveryRequestCount?: number;
}
export interface GitLabDirectoryPointer {
  /** URL-encoded as one API project identifier, including namespace segments. */
  projectPath: string;
  /** Original branch/tag/ref from the user URL. */
  ref: string;
  path: string;
  /** Immutable commit SHA resolved from `ref` before any content fetch. */
  resolvedSha?: string;
}
