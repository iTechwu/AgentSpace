import type { SkillSkillDependency } from "@dofe-agent/domain";
import { resolveSystemDependencySync } from "./system-dependency-catalog.ts";

/** Extracts the frontmatter body as lines, or null when there is no frontmatter. */
function extractFrontmatterLines(skillMarkdown: string): string[] | null {
  const match = skillMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  return match ? match[1].split(/\r?\n/) : null;
}

export type SkillDependencyManager = "npm" | "pip" | "uv" | "system";

export interface SkillDependencyDeclaration {
  manager: SkillDependencyManager;
  name: string;
  version: string;
  integrity?: string;
}

export function parseSkillDependencyDeclarations(skillMarkdown: string): SkillDependencyDeclaration[] {
  const lines = extractFrontmatterLines(skillMarkdown);
  if (!lines) {
    return [];
  }

  const declarations: SkillDependencyDeclaration[] = [];
  let inDependencies = false;
  for (const rawLine of lines) {
    if (/^dependencies\s*:\s*$/.test(rawLine.trim())) {
      inDependencies = true;
      continue;
    }
    if (!inDependencies) {
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break;
    }
    const match = rawLine.match(/^\s+-\s+(.+)\s*$/);
    if (!match) {
      if (rawLine.trim()) {
        throw new Error("Skill dependencies must be a YAML list.");
      }
      continue;
    }
    declarations.push(parseSkillDependencyDeclaration(stripYamlScalar(match[1]!.trim())));
  }

  return uniqueDeclarations(declarations);
}

/**
 * Parses a `skillDependencies:` frontmatter block — a YAML list of mappings
 * describing Skill→Skill dependencies. Distinct from `dependencies` (runtime
 * package managers), these carry a stable `coordinate`, a version RANGE, a
 * placement, and a required flag. The author declares the range; the install
 * plan resolves it to an exact artifact digest.
 */
export function parseSkillSkillDependencies(skillMarkdown: string): SkillSkillDependency[] {
  const lines = extractFrontmatterLines(skillMarkdown);
  if (!lines) {
    return [];
  }
  const dependencies: SkillSkillDependency[] = [];
  let current: Record<string, string> | null = null;
  let inSkillDependencies = false;

  const flush = () => {
    if (!current) return;
    dependencies.push(finishSkillDependencyMapping(current));
    current = null;
  };

  for (const rawLine of lines) {
    if (/^skillDependencies\s*:\s*$/.test(rawLine.trim())) {
      inSkillDependencies = true;
      continue;
    }
    if (!inSkillDependencies) continue;
    // A new top-level key (no leading whitespace) ends the block.
    if (/^\S/.test(rawLine)) break;

    const item = rawLine.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      flush();
      current = {};
      assignSkillDependencyEntry(current, item[1]!);
      continue;
    }
    const kv = rawLine.match(/^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (kv && current) {
      current[kv[1]!] = stripYamlScalar(kv[2]!);
      continue;
    }
    if (rawLine.trim()) {
      throw new Error("skillDependencies must be a YAML list of key: value mappings.");
    }
  }
  flush();
  return uniqueSkillDependencies(dependencies);
}

function assignSkillDependencyEntry(target: Record<string, string>, text: string): void {
  const separator = text.indexOf(":");
  if (separator <= 0) {
    throw new Error("skillDependencies entries must be key: value mappings.");
  }
  const key = text.slice(0, separator).trim();
  const value = stripYamlScalar(text.slice(separator + 1).trim());
  target[key] = value;
}

function finishSkillDependencyMapping(record: Record<string, string>): SkillSkillDependency {
  const coordinate = record.coordinate?.trim();
  const version = record.version?.trim();
  const placement = record.placement?.trim();
  const requiredValue = record.required?.trim();

  if (!coordinate || !/^[a-z][a-z0-9+.-]*:/.test(coordinate)) {
    throw new Error(
      `Invalid skillDependencies coordinate "${coordinate ?? ""}". Coordinate must carry a scheme prefix (e.g. github:owner/repo/skills/name).`,
    );
  }
  if (!version) {
    throw new Error(`skillDependencies coordinate "${coordinate}" requires a version range.`);
  }
  if (placement !== "same_runtime" && placement !== "workflow") {
    throw new Error(`Invalid skillDependencies placement "${placement ?? ""}". Use same_runtime or workflow.`);
  }
  let required = true;
  if (requiredValue !== undefined && requiredValue !== "") {
    const normalized = requiredValue.toLowerCase();
    if (normalized === "true") required = true;
    else if (normalized === "false") required = false;
    else throw new Error(`Invalid skillDependencies required "${requiredValue}". Use true or false.`);
  }
  return { coordinate, version, placement, required };
}

function uniqueSkillDependencies(dependencies: SkillSkillDependency[]): SkillSkillDependency[] {
  const seen = new Map<string, SkillSkillDependency>();
  const result: SkillSkillDependency[] = [];
  for (const dependency of dependencies) {
    const key = dependency.coordinate.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      if (
        existing.version !== dependency.version
        || existing.placement !== dependency.placement
        || existing.required !== dependency.required
      ) {
        throw new Error(`Conflicting skillDependencies for "${dependency.coordinate}": version/placement mismatch.`);
      }
      continue;
    }
    seen.set(key, dependency);
    result.push(dependency);
  }
  return result;
}

export function readSkillDependencyDeclarations(configJson: string | undefined): SkillDependencyDeclaration[] {
  if (!configJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(configJson) as { dependencies?: unknown };
    if (!Array.isArray(parsed.dependencies)) {
      return [];
    }
    return uniqueDeclarations(parsed.dependencies.map(parseStoredDeclaration));
  } catch {
    return [];
  }
}

export function parseSkillDependencyDeclaration(value: string): SkillDependencyDeclaration {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid skill dependency "${value}". Use npm:package@1.2.3, pip:package==1.2.3, or uv:package==1.2.3.`);
  }
  const manager = value.slice(0, separator).trim();
  const reference = value.slice(separator + 1).trim();
  if (manager === "npm") {
    const match = reference.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    if (!match) {
      throw new Error(`Invalid npm dependency "${reference}". npm dependencies require an exact version.`);
    }
    return { manager, name: match[1]!, version: match[2]! };
  }
  if (manager === "pip" || manager === "uv") {
    const match = reference.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==(\d+(?:\.\d+)+(?:[A-Za-z0-9._+-]*)?)$/);
    if (!match) {
      throw new Error(`Invalid ${manager} dependency "${reference}". Python dependencies require an exact version.`);
    }
    return { manager, name: match[1]!, version: match[2]! };
  }
  if (manager === "system") {
    const match = reference.match(/^([a-z0-9][a-z0-9._+-]*)$/i);
    if (!match) {
      throw new Error(`Invalid system dependency "${reference}". Use system:ffmpeg.`);
    }
    // Fail-closed: an unknown or non-installable system package is rejected here.
    const resolved = resolveSystemDependencySync(match[1]!);
    if (!resolved) {
      throw new Error(`Unknown system dependency "${reference}". It is not in the allow-list catalog.`);
    }
    if (!resolved.allowInstall) {
      throw new Error(`System dependency "${resolved.name}" is not allowed for installation.`);
    }
    return { manager: "system", name: resolved.name, version: "system" };
  }
  throw new Error(`Unsupported skill dependency manager "${manager}".`);
}

function parseStoredDeclaration(value: unknown): SkillDependencyDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid stored skill dependency.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.manager !== "string" || typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error("Invalid stored skill dependency.");
  }
  const parsed = parseSkillDependencyDeclaration(
    record.manager === "npm"
      ? `npm:${record.name}@${record.version}`
      : record.manager === "system"
        ? `system:${record.name}`
        : `${record.manager}:${record.name}==${record.version}`,
  );
  return typeof record.integrity === "string" && record.integrity.trim()
    ? { ...parsed, integrity: record.integrity.trim() }
    : parsed;
}

function uniqueDeclarations(declarations: SkillDependencyDeclaration[]): SkillDependencyDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((dependency) => {
    const key = `${dependency.manager}:${dependency.name}@${dependency.version}`.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
