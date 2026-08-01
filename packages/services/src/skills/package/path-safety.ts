import type { SkillPackageErrorCode } from "@dofe-agent/domain";

/**
 * Path safety for skill package files.
 *
 * Unlike the legacy `normalizeSkillFilePath` (shared/helpers.ts), which
 * *silently strips* `.`/`..` segments, the package contract must *reject*
 * traversal attempts with an explicit error code. Silent stripping let
 * unsafe paths round-trip; the DSP model fails closed.
 */

export interface SafePathOk {
  ok: true;
  normalized: string;
  depth: number;
}
export interface SafePathErr {
  ok: false;
  code: SkillPackageErrorCode;
  message: string;
  rawPath: string;
}

/**
 * Validate and normalize a single relative path.
 * - Rejects absolute paths (POSIX `/` or Windows drive `C:\`).
 * - Rejects any `..` segment (path traversal).
 * - Rejects backslashes by normalizing to `/` first (so `..\x` is caught).
 * - Rejects empty/whitespace-only paths.
 */
export function classifySkillFilePath(rawPath: string): SafePathOk | SafePathErr {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, code: "PATH_TRAVERSAL", message: "Empty skill file path.", rawPath };
  }

  const forward = rawPath.replace(/\\/g, "/");

  if (forward.startsWith("/")) {
    return { ok: false, code: "ABSOLUTE_PATH", message: "Absolute paths are not allowed.", rawPath };
  }
  // Windows drive letter e.g. C:/...
  if (/^[a-zA-Z]:[\\/]/.test(forward)) {
    return { ok: false, code: "ABSOLUTE_PATH", message: "Absolute paths are not allowed.", rawPath };
  }

  const segments = forward.split("/").map((segment) => segment.trim());

  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return {
        ok: false,
        code: "PATH_TRAVERSAL",
        message: "Parent-directory (`..`) segments are not allowed.",
        rawPath,
      };
    }
    normalizedSegments.push(segment);
  }

  if (normalizedSegments.length === 0) {
    return { ok: false, code: "PATH_TRAVERSAL", message: "Empty skill file path.", rawPath };
  }

  const normalized = normalizedSegments.join("/");
  return { ok: true, normalized, depth: normalizedSegments.length };
}

/** Maximum nesting depth of a normalized path (file at root = 1). */
export function skillPathDepth(normalizedPath: string): number {
  return normalizedPath.split("/").filter((segment) => segment.length > 0).length;
}
