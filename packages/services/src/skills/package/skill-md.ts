import { parse as parseYaml } from "yaml";
import type { SkillPackageErrorCode } from "@dofe-agent/domain";

/**
 * `SKILL.md` frontmatter parsing with a full YAML parser (YAML 1.2).
 *
 * Replaces the hand-rolled scanners in skill-metadata.ts / dependencies.ts /
 * requirements.ts for the *baseline* fields. Unknown frontmatter keys are
 * preserved verbatim (never rewritten upstream) and exposed via `raw` so the
 * manifest synthesizer and legacy declaration parsers can read them.
 */

export interface ParsedSkillFrontmatter {
  hasFrontmatter: boolean;
  name: string;
  description: string;
  /** Full parsed frontmatter object, preserving unknown keys. */
  raw: Record<string, unknown>;
  /** Markdown body following the frontmatter fence. */
  body: string;
}

export interface ParsedSkillMarkdownOk {
  ok: true;
  frontmatter: ParsedSkillFrontmatter;
}
export interface ParsedSkillMarkdownErr {
  ok: false;
  code: SkillPackageErrorCode;
  message: string;
}

export type ParsedSkillMarkdown = ParsedSkillMarkdownOk | ParsedSkillMarkdownErr;

const FRONTMATTER_PATTERN = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/;

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return { ok: false, code: "SKILL_MD_MISSING", message: "SKILL.md is empty." };
  }

  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) {
    // No frontmatter fence. The Agent Skills baseline requires a `name`, so a
    // frontmatter-less SKILL.md is a contract violation, not a silent fallback.
    return {
      ok: false,
      code: "FRONTMATTER_INVALID",
      message: "SKILL.md must begin with a YAML frontmatter block (---) declaring at least `name`.",
    };
  }

  const frontmatterText = match[1] ?? "";
  const body = match[2] ?? "";

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch (error) {
    return {
      ok: false,
      code: "FRONTMATTER_INVALID",
      message: `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      code: "FRONTMATTER_INVALID",
      message: "SKILL.md frontmatter is empty.",
    };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "FRONTMATTER_INVALID",
      message: "SKILL.md frontmatter must be a YAML mapping.",
    };
  }

  const raw = parsed as Record<string, unknown>;
  const name = readScalarString(raw.name);
  if (!name) {
    return {
      ok: false,
      code: "FRONTMATTER_INVALID",
      message: "SKILL.md frontmatter must declare a non-empty string `name`.",
    };
  }
  const description = readScalarString(raw.description) ?? "";

  return {
    ok: true,
    frontmatter: {
      hasFrontmatter: true,
      name,
      description,
      raw,
      body,
    },
  };
}

function readScalarString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * Best-effort extraction of a frontmatter field as a trimmed string. Used by
 * the manifest synthesizer for optional metadata (e.g. `version`, `license`).
 */
export function readFrontmatterString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  const result = readScalarString(value);
  return result && result.length > 0 ? result : undefined;
}
