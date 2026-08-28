/**
 * Centralized limits for skill package ingestion. A single source of truth
 * shared by the services import engine and the daemon skill-imports path
 * (see 06-实施计划.md §4.3 — eliminate the two divergent allow-lists).
 */

/** Max compressed archive upload size (zip upload / registry download). */
export const MAX_SKILL_ARCHIVE_BYTES = 10 * 1024 * 1024;

/** Max number of entries inside an archive. */
export const MAX_SKILL_ARCHIVE_FILES = 100;

/** Max total uncompressed bytes across all archive entries (anti zip bomb). */
export const MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

/** Max directory nesting depth inside an archive/directory source. */
export const MAX_SKILL_ARCHIVE_NESTING_DEPTH = 8;

/** Max number of files in a resolved package (post-flatten). */
export const MAX_SKILL_PACKAGE_FILES = 200;

/** Max size of a single file in a package. */
export const MAX_SKILL_SINGLE_FILE_BYTES = 8 * 1024 * 1024;

export interface SkillIngestLimits {
  archiveBytes: number;
  archiveFiles: number;
  uncompressedBytes: number;
  nestingDepth: number;
  packageFiles: number;
  singleFileBytes: number;
}

export const DEFAULT_SKILL_INGEST_LIMITS: SkillIngestLimits = {
  archiveBytes: MAX_SKILL_ARCHIVE_BYTES,
  archiveFiles: MAX_SKILL_ARCHIVE_FILES,
  uncompressedBytes: MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES,
  nestingDepth: MAX_SKILL_ARCHIVE_NESTING_DEPTH,
  packageFiles: MAX_SKILL_PACKAGE_FILES,
  singleFileBytes: MAX_SKILL_SINGLE_FILE_BYTES,
};
