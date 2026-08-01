import type { SkillPackageErrorCode } from "@dofe-agent/domain";

/**
 * A single package validation/inspection problem. `code` is the stable
 * identifier surfaced to the UI; inspection must never fail silently.
 */
export interface SkillPackageError {
  code: SkillPackageErrorCode;
  message: string;
  cause?: {
    path?: string;
    detail?: string;
  };
}

export function skillPackageError(
  code: SkillPackageErrorCode,
  message: string,
  cause?: { path?: string; detail?: string },
): SkillPackageError {
  return { code, message, cause };
}
