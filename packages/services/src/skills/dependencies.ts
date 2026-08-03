import { resolveSystemDependencySync } from "./system-dependency-catalog.ts";

export type SkillDependencyManager = "npm" | "pip" | "uv" | "system";

export interface SkillDependencyDeclaration {
  manager: SkillDependencyManager;
  name: string;
  version: string;
  integrity?: string;
}

export function parseSkillDependencyDeclarations(skillMarkdown: string): SkillDependencyDeclaration[] {
  const frontmatterMatch = skillMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!frontmatterMatch) {
    return [];
  }

  const declarations: SkillDependencyDeclaration[] = [];
  let inDependencies = false;
  for (const rawLine of frontmatterMatch[1].split(/\r?\n/)) {
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
