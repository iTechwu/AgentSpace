// 技能导入的本地目录与 zip 读取及预算（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { sameValue } from "../../shared/helpers.ts";
import { MAX_SKILL_ARCHIVE_BYTES, MAX_SKILL_ARCHIVE_FILES, MAX_SKILL_ARCHIVE_NESTING_DEPTH, MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES, MAX_SKILL_SINGLE_FILE_BYTES } from "../package/archive-limits.ts";
import { classifySkillFilePath } from "../package/path-safety.ts";
import { unzipSync } from "fflate";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSkillSourceFileBudget } from "./fetch-gitlab.ts";
import { sortImportedSkillFiles } from "./http-shared.ts";
import type { ImportedSkillFile, SkillSourceBudget } from "./types.ts";

export async function readLocalSkillDirectoryFiles(
  directoryPath: string,
  warnings: string[],
  relativePrefix = "",
  requireSkillFile = true,
  budget: SkillSourceBudget = { fileCount: 0, totalBytes: 0, requestCount: 0 },
): Promise<ImportedSkillFile[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: ImportedSkillFile[] = [];

  for (const entry of entries) {
    const rawRelativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`Local skill directory contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const relativePath = pathResult.normalized;

    const absoluteEntryPath = resolve(directoryPath, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(absoluteEntryPath).catch(() => undefined);
      throw new Error(
        `Symlink "${relativePath}"${linkTarget ? ` -> "${linkTarget}"` : ""} is not allowed in skill packages.`,
      );
    }

    if (entry.isDirectory()) {
      files.push(...await readLocalSkillDirectoryFiles(absoluteEntryPath, warnings, relativePath, false, budget));
      continue;
    }

    if (!entry.isFile()) {
      warnings.push(`Skipped unsupported local entry: ${relativePath}`);
      continue;
    }

    const entryStats = await stat(absoluteEntryPath);
    const bytes = new Uint8Array(await readFile(absoluteEntryPath));
    assertSkillSourceFileBudget(budget, relativePath, bytes, "Local skill directory");
    files.push({
      path: relativePath,
      bytes,
      mode: (entryStats.mode & 0o777).toString(8),
    });
  }

  if (requireSkillFile && !files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error(`Local skill directory must contain SKILL.md: ${directoryPath}`);
  }

  return sortImportedSkillFiles(files);
}
export async function readLocalSkillZipFiles(
  archivePath: string,
  warnings: string[],
): Promise<ImportedSkillFile[]> {
  return readSkillZipFiles(new Uint8Array(await readFile(archivePath)), warnings, "Local skill archive");
}
export function readSkillZipFiles(
  archiveBytes: Uint8Array,
  warnings: string[],
  sourceLabel: string,
): ImportedSkillFile[] {
  if (archiveBytes.byteLength === 0) {
    throw new Error(`${sourceLabel} cannot be empty.`);
  }
  if (archiveBytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error(`${sourceLabel} exceeds the ${MAX_SKILL_ARCHIVE_BYTES} byte upload limit.`);
  }
  assertZipCentralDirectoryBudgets(archiveBytes, sourceLabel);

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(archiveBytes);
  } catch {
    throw new Error(`${sourceLabel} is not a valid zip archive.`);
  }
  const entries = Object.entries(archive);
  if (entries.length > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_ARCHIVE_FILES} files.`);
  }

  const files: ImportedSkillFile[] = [];
  let uncompressedBytes = 0;
  let nestingDepth = 0;

  for (const [entryName, content] of entries) {
    const rawPath = classifySkillFilePath(entryName);
    if (!rawPath.ok) {
      throw new Error(`${sourceLabel} contains unsafe entry "${entryName}": ${rawPath.message}`);
    }
    const normalizedPath = rawPath.normalized;
    if (!normalizedPath) {
      continue;
    }
    const depth = normalizedPath.split("/").length;
    if (depth > nestingDepth) {
      nestingDepth = depth;
    }
    if (nestingDepth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
      throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
    }
    uncompressedBytes += content.byteLength;
    if (uncompressedBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`${sourceLabel} expands beyond the ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} byte extraction limit.`);
    }
    if (content.byteLength > MAX_SKILL_SINGLE_FILE_BYTES) {
      throw new Error(`${sourceLabel} entry "${normalizedPath}" exceeds the ${MAX_SKILL_SINGLE_FILE_BYTES} byte single-file limit.`);
    }
    files.push({
      path: normalizedPath,
      bytes: content,
    });
  }

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error(`${sourceLabel} must contain SKILL.md.`);
  }

  return sortImportedSkillFiles(files);
}
export function assertZipCentralDirectoryBudgets(archiveBytes: Uint8Array, sourceLabel: string): void {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const minimumEocdBytes = 22;
  const searchStart = Math.max(0, archiveBytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = archiveBytes.byteLength - minimumEocdBytes; offset >= searchStart; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50
      && offset + minimumEocdBytes + view.getUint16(offset + 20, true) === archiveBytes.byteLength
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`${sourceLabel} has no valid zip central directory.`);

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw new Error(`${sourceLabel} uses an unsupported multi-disk or ZIP64 layout.`);
  }
  if (entryCount > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_ARCHIVE_FILES} files.`);
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset < 0 || centralEnd > eocdOffset || centralEnd > archiveBytes.byteLength) {
    throw new Error(`${sourceLabel} has an invalid zip central directory boundary.`);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`${sourceLabel} has an invalid zip central directory entry.`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const declaredBytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0 || declaredBytes === 0xffffffff || next > centralEnd) {
      throw new Error(`${sourceLabel} contains an encrypted, ZIP64, or truncated entry.`);
    }
    let entryName: string;
    try {
      entryName = decoder.decode(archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error(`${sourceLabel} contains a non-UTF-8 entry name.`);
    }
    const path = classifySkillFilePath(entryName);
    if (!path.ok) throw new Error(`${sourceLabel} contains unsafe entry "${entryName}": ${path.message}`);
    if (path.depth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
      throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
    }
    if (!entryName.endsWith("/") && declaredBytes > MAX_SKILL_SINGLE_FILE_BYTES) {
      throw new Error(`${sourceLabel} entry "${path.normalized}" declares more than ${MAX_SKILL_SINGLE_FILE_BYTES} uncompressed bytes.`);
    }
    declaredTotal += declaredBytes;
    if (declaredTotal > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`${sourceLabel} declares more than ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} uncompressed bytes.`);
    }
    cursor = next;
  }
  if (cursor !== centralEnd) throw new Error(`${sourceLabel} has trailing data inside its zip central directory.`);
}
