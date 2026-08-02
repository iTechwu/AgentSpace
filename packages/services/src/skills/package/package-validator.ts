import type { DspManifest, DspFileEntry } from "@dofe-agent/domain";
import { classifySkillFilePath } from "./path-safety.ts";
import { classifySkillFile, normalizeSkillFileMode } from "./skill-file-policy.ts";
import { parseSkillMarkdown, readFrontmatterString } from "./skill-md.ts";
import { validateDspManifest } from "./manifest-schema.ts";
import { sha256Hex } from "./package-digest.ts";
import { skillPackageError, type SkillPackageError } from "./errors.ts";
import { DEFAULT_SKILL_INGEST_LIMITS, type SkillIngestLimits } from "./archive-limits.ts";
import { parseSkillDependencyDeclarations } from "../dependencies.ts";

/**
 * Validates a normalized skill file set into an immutable artifact contract.
 *
 * Source-agnostic: a directory read, a ZIP extract, and a Git tree resolve all
 * three into the same `SkillPackageInputFile[]` shape, so the same logical
 * skill yields the same artifact digest regardless of origin (Phase 0 gate).
 */

export interface SkillPackageInputFile {
  path: string;
  bytes: Uint8Array;
  mode?: string;
  /** If set, this entry is a symlink and must be rejected as undeclared. */
  symlinkTarget?: string;
}

export interface ValidatedSkillFile {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  mode: string;
  isBinary: boolean;
  inlineableText: boolean;
  /** UTF-8 text content; present only when `inlineableText`. */
  textContent?: string;
}

export interface SkillPackageValidation {
  ok: boolean;
  errors: SkillPackageError[];
  files: ValidatedSkillFile[];
  /** Synthesized manifest; present when SKILL.md is valid. */
  manifest?: DspManifest;
  skillMd?: { name: string; description: string; raw: Record<string, unknown> };
}

const MANIFEST_PATH = ".dofe/manifest.json";
const SKILL_MD_PATH = "SKILL.md";

const UTF8_DECODER = new TextDecoder("utf-8");

export function validateSkillPackage(input: {
  files: SkillPackageInputFile[];
  /** Pre-parsed manifest value (e.g. already read from `.dofe/manifest.json`). */
  manifest?: unknown;
  limits?: Partial<SkillIngestLimits>;
}): SkillPackageValidation {
  const limits = { ...DEFAULT_SKILL_INGEST_LIMITS, ...input.limits };
  const errors: SkillPackageError[] = [];
  const validated: ValidatedSkillFile[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  if (input.files.length === 0) {
    errors.push(skillPackageError("EMPTY_PACKAGE", "Skill package contains no files."));
  }

  for (const file of input.files) {
    const pathResult = classifySkillFilePath(file.path);
    if (!pathResult.ok) {
      errors.push(skillPackageError(pathResult.code, pathResult.message, { path: file.path }));
      continue;
    }
    const path = pathResult.normalized;

    if (file.symlinkTarget !== undefined) {
      errors.push(
        skillPackageError(
          "UNDECLARED_SYMLINK",
          `Symlink "${path}" -> "${file.symlinkTarget}" is not allowed in skill packages.`,
          { path, detail: file.symlinkTarget },
        ),
      );
      continue;
    }

    if (seenPaths.has(path)) {
      errors.push(
        skillPackageError("DUPLICATE_PATH", `Duplicate file path "${path}".`, { path }),
      );
      continue;
    }
    seenPaths.add(path);
    totalBytes += file.bytes.byteLength;

    if (pathResult.depth > limits.nestingDepth) {
      errors.push(
        skillPackageError(
          "PATH_TRAVERSAL",
          `File "${path}" exceeds the ${limits.nestingDepth} level nesting limit.`,
          { path },
        ),
      );
    }

    if (file.bytes.byteLength > limits.singleFileBytes) {
      errors.push(
        skillPackageError(
          "ARCHIVE_TOO_LARGE",
          `File "${path}" exceeds the ${limits.singleFileBytes} byte single-file limit.`,
          { path, detail: `${file.bytes.byteLength} bytes` },
        ),
      );
    }

    const classification = classifySkillFile(path, file.bytes);
    const mode = normalizeSkillFileMode(file.mode ?? classification.suggestedMode);
    const sha256 = sha256Hex(file.bytes);
    const validatedFile: ValidatedSkillFile = {
      path,
      sha256,
      size: file.bytes.byteLength,
      mediaType: classification.mediaType,
      mode,
      isBinary: classification.isBinary,
      inlineableText: classification.inlineableText,
      ...(classification.inlineableText
        ? { textContent: UTF8_DECODER.decode(file.bytes) }
        : {}),
    };
    validated.push(validatedFile);
  }

  if (validated.length > limits.packageFiles) {
    errors.push(
      skillPackageError(
        "MAX_FILES_EXCEEDED",
        `Package contains ${validated.length} files; limit is ${limits.packageFiles}.`,
      ),
    );
  }
  if (totalBytes > limits.uncompressedBytes) {
    errors.push(
      skillPackageError(
        "ARCHIVE_TOO_LARGE",
        `Package content is ${totalBytes} bytes; limit is ${limits.uncompressedBytes}.`,
      ),
    );
  }

  // Locate SKILL.md at the package root.
  const skillMdFile = validated.find((file) => file.path === SKILL_MD_PATH);
  if (!skillMdFile) {
    errors.push(skillPackageError("SKILL_MD_MISSING", "Package is missing a root SKILL.md."));
  }

  let parsed:
    | { ok: true; frontmatter: { name: string; description: string; raw: Record<string, unknown> }; body: string }
    | { ok: false; code: import("@dofe-agent/domain").SkillPackageErrorCode; message: string }
    | undefined;

  if (skillMdFile) {
    if (!skillMdFile.inlineableText || skillMdFile.textContent === undefined) {
      errors.push(
        skillPackageError("FRONTMATTER_INVALID", "SKILL.md is not valid UTF-8 text.", {
          path: SKILL_MD_PATH,
        }),
      );
    } else {
      const result = parseSkillMarkdown(skillMdFile.textContent);
      if (result.ok) {
        parsed = {
          ok: true,
          frontmatter: {
            name: result.frontmatter.name,
            description: result.frontmatter.description,
            raw: result.frontmatter.raw,
          },
          body: result.frontmatter.body,
        };
      } else {
        parsed = { ok: false, code: result.code, message: result.message };
        errors.push(skillPackageError(result.code, result.message, { path: SKILL_MD_PATH }));
      }
    }
  }

  // Validate a submitted manifest if one was supplied.
  const submittedManifestResult =
    input.manifest !== undefined
      ? { manifest: input.manifest, invalid: false }
      : readSubmittedManifestFromFiles(validated);
  if (submittedManifestResult.invalid) {
    errors.push(
      skillPackageError("MANIFEST_INVALID", ".dofe/manifest.json exists but is not valid JSON.", {
        path: MANIFEST_PATH,
      }),
    );
  }

  let submittedManifest: DspManifest | undefined;
  if (submittedManifestResult.manifest !== undefined) {
    const manifestResult = validateDspManifest(submittedManifestResult.manifest);
    if (!manifestResult.ok) {
      errors.push(
        skillPackageError(
          "MANIFEST_INVALID",
          `manifest.json failed schema validation: ${manifestResult.errors.join("; ")}`,
          { path: MANIFEST_PATH },
        ),
      );
    } else {
      submittedManifest = submittedManifestResult.manifest as DspManifest;
      if (Array.isArray((submittedManifest as { files?: unknown }).files)) {
        // Cross-check declared file digests against computed content.
        const declared = submittedManifest.files;
        const computedByPath = new Map(
          validated
            .filter((file) => file.path !== MANIFEST_PATH)
            .map((file) => [file.path, file]),
        );
        const declaredPaths = new Set<string>();
        for (const entry of declared) {
          const declaredPathResult = classifySkillFilePath(entry.path);
          if (!declaredPathResult.ok || declaredPathResult.normalized === MANIFEST_PATH) {
            errors.push(
              skillPackageError("MANIFEST_INVALID", `manifest.json contains an invalid file path "${entry.path}".`, {
                path: entry.path,
              }),
            );
            continue;
          }
          const declaredPath = declaredPathResult.normalized;
          if (declaredPaths.has(declaredPath)) {
            errors.push(skillPackageError("MANIFEST_INVALID", `manifest.json declares "${declaredPath}" more than once.`, {
              path: declaredPath,
            }));
            continue;
          }
          declaredPaths.add(declaredPath);
          const computed = computedByPath.get(declaredPath);
          if (!computed) {
            errors.push(
              skillPackageError(
                "MANIFEST_INVALID",
                `manifest.json declares file "${declaredPath}" that is not present in the package.`,
                { path: declaredPath },
              ),
            );
            continue;
          }
          if (computed.sha256 !== entry.sha256 || (entry.size !== undefined && computed.size !== entry.size)) {
            errors.push(
              skillPackageError(
                "DIGEST_MISMATCH",
                `manifest.json declares a different digest/size for "${entry.path}".`,
                { path: entry.path, detail: `declared ${entry.sha256.slice(0, 12)}… vs computed ${computed.sha256.slice(0, 12)}…` },
              ),
            );
          }
          if (entry.mediaType !== computed.mediaType) {
            errors.push(skillPackageError(
              "MANIFEST_INVALID",
              `manifest.json declares mediaType "${entry.mediaType}" for "${declaredPath}", computed "${computed.mediaType}".`,
              { path: declaredPath },
            ));
          }
          if (entry.mode) {
            computed.mode = normalizeSkillFileMode(entry.mode);
          }
        }
        for (const computedPath of computedByPath.keys()) {
          if (!declaredPaths.has(computedPath)) {
            errors.push(skillPackageError(
              "MANIFEST_INVALID",
              `Package contains undeclared file "${computedPath}".`,
              { path: computedPath },
            ));
          }
        }
        if (parsed?.ok) {
          if (submittedManifest.artifact.name !== parsed.frontmatter.name) {
            errors.push(skillPackageError(
              "MANIFEST_INVALID",
              `manifest artifact name "${submittedManifest.artifact.name}" does not match SKILL.md name "${parsed.frontmatter.name}".`,
              { path: MANIFEST_PATH },
            ));
          }
          const frontmatterVersion = readFrontmatterString(parsed.frontmatter.raw, "version");
          if (frontmatterVersion && submittedManifest.artifact.version
            && frontmatterVersion !== submittedManifest.artifact.version) {
            errors.push(skillPackageError(
              "MANIFEST_INVALID",
              `manifest version "${submittedManifest.artifact.version}" conflicts with SKILL.md version "${frontmatterVersion}".`,
              { path: MANIFEST_PATH },
            ));
          }
          const frontmatterDependencies = parseSkillDependencyDeclarations(
            `---\n${serializeFrontmatter(parsed.frontmatter.raw)}\n---\n${parsed.body}`,
          );
          if (frontmatterDependencies.length > 0 && submittedManifest.dependencies) {
            const submittedKeys = submittedManifest.dependencies
              .map((dependency) => `${dependency.kind}:${dependency.name}@${dependency.version}`)
              .sort();
            const frontmatterKeys = frontmatterDependencies
              .map((dependency) => `${dependency.manager}:${dependency.name}@${dependency.version}`)
              .sort();
            if (JSON.stringify(submittedKeys) !== JSON.stringify(frontmatterKeys)) {
              errors.push(skillPackageError(
                "MANIFEST_INVALID",
                "manifest dependencies conflict with SKILL.md dependencies.",
                { path: MANIFEST_PATH },
              ));
            }
          }
        }
      }
    }
  }

  // Synthesize the canonical manifest from validated content files.
  let manifest: DspManifest | undefined;
  if (parsed?.ok) {
    manifest = synthesizeManifest(parsed.frontmatter, parsed.body, validated, submittedManifest);
  }

  return {
    ok: errors.length === 0 && manifest !== undefined,
    errors,
    files: validated,
    ...(manifest ? { manifest } : {}),
    ...(parsed?.ok
      ? {
          skillMd: {
            name: parsed.frontmatter.name,
            description: parsed.frontmatter.description,
            raw: parsed.frontmatter.raw,
          },
        }
      : {}),
  };
}

function readSubmittedManifestFromFiles(files: ValidatedSkillFile[]): { manifest?: unknown; invalid: boolean } {
  const manifestFile = files.find((file) => file.path === MANIFEST_PATH);
  if (!manifestFile || manifestFile.textContent === undefined) {
    return { invalid: false };
  }
  try {
    return { manifest: JSON.parse(manifestFile.textContent) as unknown, invalid: false };
  } catch {
    return { invalid: true };
  }
}

function synthesizeManifest(
  frontmatter: { name: string; description: string; raw: Record<string, unknown> },
  skillMdBody: string,
  files: ValidatedSkillFile[],
  submittedManifest?: DspManifest,
): DspManifest {
  const version = submittedManifest?.artifact.version
    ?? readFrontmatterString(frontmatter.raw, "version")
    ?? "";

  // Content files exclude the platform metadata file itself.
  const contentFiles: DspFileEntry[] = files
    .filter((file) => file.path !== MANIFEST_PATH)
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      mediaType: file.mediaType,
      mode: file.mode,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const manifest: DspManifest = {
    schemaVersion: 1,
    artifact: { name: frontmatter.name, version },
    files: contentFiles,
  };

  // Reuse the validated dependency parser so the synthesized manifest matches
  // the existing `dependencies:` frontmatter contract exactly.
  const skillMarkdown = `---\n${serializeFrontmatter(frontmatter.raw)}\n---\n${skillMdBody}`;
  const frontmatterDependencies = parseSkillDependencyDeclarations(skillMarkdown);
  if (submittedManifest?.dependencies) {
    manifest.dependencies = submittedManifest.dependencies;
  } else if (frontmatterDependencies.length > 0) {
    manifest.dependencies = frontmatterDependencies.map((dependency) => ({
      kind: dependency.manager,
      name: dependency.name,
      version: dependency.version,
    }));
  }

  // Preserve platform-level declarations from a validated submitted manifest.
  // The validator already checked these fields against the DSP schema; files
  // and artifact digest are always computed, never trusted from submission.
  if (submittedManifest?.capabilities) {
    manifest.capabilities = submittedManifest.capabilities;
  }
  if (submittedManifest?.services) {
    manifest.services = submittedManifest.services;
  }
  if (submittedManifest?.entrypoints) {
    manifest.entrypoints = submittedManifest.entrypoints;
  }

  return manifest;
}

function serializeFrontmatter(raw: Record<string, unknown>): string {
  // Minimal, stable serialization only used to re-feed the dependency parser,
  // which scans the raw `dependencies:` list textually. We preserve the
  // original list if present; otherwise emit nothing.
  const dependencies = raw.dependencies;
  if (Array.isArray(dependencies)) {
    const lines = dependencies
      .map((entry) => `  - ${String(entry)}`)
      .join("\n");
    return `name: ${String(raw.name ?? "")}\ndependencies:\n${lines}`;
  }
  return `name: ${String(raw.name ?? "")}`;
}
