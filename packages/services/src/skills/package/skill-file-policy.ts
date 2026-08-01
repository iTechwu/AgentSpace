/**
 * Unified skill file policy — the single source of truth for which files a
 * skill package may contain, how they are classified, and how executable mode
 * is inferred.
 *
 * Replaces the two divergent `IMPORTABLE_TEXT_EXTENSIONS` sets that previously
 * lived in `packages/services/src/skills/import.ts` (had `.mjs`, `.html`) and
 * `packages/daemon/src/skill-imports.ts` (lacked both). See 06-实施计划.md §4.3.
 */

/** Whitelisted text extensions. Superset of both legacy lists. */
export const SKILL_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".js",
  ".mjs",
  ".ts",
  ".py",
  ".sh",
  ".html",
]);

/** Extensions that imply an executable script (suggested mode 0755). */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".sh", ".py", ".js", ".mjs", ".ts"]);

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".csv": "text/csv",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".py": "text/x-python",
  ".sh": "application/x-sh",
  ".html": "text/html",
};

export function skillFileExtension(path: string): string {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

export function inferSkillMediaType(path: string): string {
  return EXTENSION_TO_MEDIA_TYPE[skillFileExtension(path)] ?? "application/octet-stream";
}

/** A file is inlineable text when its extension is whitelisted. */
export function isImportableSkillTextFile(path: string): boolean {
  if (path === "SKILL.md") {
    return true;
  }
  return SKILL_TEXT_EXTENSIONS.has(skillFileExtension(path));
}

/**
 * Heuristic binary detection. A file is binary if it contains a NUL byte in the
 * first 8 KB, or if that sample is not valid UTF-8. Binary files are NEVER
 * coerced to a UTF-8 string — they are stored as blobs (Phase 1).
 */
export function isLikelyBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }
  const sample = bytes.length > 8000 ? bytes.subarray(0, 8000) : bytes;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      return true;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

export interface ClassifiedSkillFile {
  mediaType: string;
  isBinary: boolean;
  /** True when the file may be inlined as UTF-8 text content. */
  inlineableText: boolean;
  suggestedMode: string;
}

export function classifySkillFile(path: string, bytes: Uint8Array): ClassifiedSkillFile {
  const isBinary = isLikelyBinaryBytes(bytes);
  const inlineableText = !isBinary && isImportableSkillTextFile(path);
  const suggestedMode = SCRIPT_EXTENSIONS.has(skillFileExtension(path)) ? "0755" : "0644";
  return {
    mediaType: inferSkillMediaType(path),
    isBinary,
    inlineableText,
    suggestedMode,
  };
}

/** Normalize a POSIX mode to a 4-digit octal string (e.g. "755" -> "0755"). */
export function normalizeSkillFileMode(mode: string | undefined): string {
  if (!mode) {
    return "0644";
  }
  let value = mode.trim().toLowerCase().replace(/^0o/, "");
  if (!/^[0-7]+$/.test(value)) {
    return "0644";
  }
  while (value.length < 4) {
    value = `0${value}`;
  }
  return value.slice(-4);
}
