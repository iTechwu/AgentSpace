// 技能导入的GitLab 目录/文件抓取与预算断言（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { sameValue } from "../../shared/helpers.ts";
import { gitAuthHeadersSync } from "../git-credentials.ts";
import { MAX_SKILL_ARCHIVE_NESTING_DEPTH, MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES, MAX_SKILL_PACKAGE_FILES, MAX_SKILL_SINGLE_FILE_BYTES } from "../package/archive-limits.ts";
import { classifySkillFilePath } from "../package/path-safety.ts";
import { readResponseBytesWithLimit, readResponseJsonWithLimit, sortImportedSkillFiles } from "./http-shared.ts";
import { MAX_SKILL_SOURCE_METADATA_BYTES, MAX_SKILL_SOURCE_REQUESTS } from "./types.ts";
import type { GitLabDirectoryPointer, ImportedSkillFile, SkillSourceBudget } from "./types.ts";

export async function fetchGitLabDirectoryFiles(
  pointer: GitLabDirectoryPointer,
  warnings: string[],
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<ImportedSkillFile[]> {
  const ref = pointer.resolvedSha ?? pointer.ref;
  const entries: Array<{ type?: string; path?: string; mode?: string }> = [];
  let page = "1";

  while (page) {
    assertSkillSourceRequestBudget(budget, "GitLab skill");
    const query = new URLSearchParams({
      path: pointer.path,
      ref,
      recursive: "true",
      per_page: "100",
      page,
    });
    const response = await fetch(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(pointer.projectPath)}/repository/tree?${query}`,
      {
        headers: {
          "User-Agent": "DofeAgent/0.1.0",
          ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch GitLab skill directory: ${response.status}`);
    }
    const payload = await readResponseJsonWithLimit(
      response,
      MAX_SKILL_SOURCE_METADATA_BYTES,
      "GitLab directory listing",
    );
    if (!Array.isArray(payload)) {
      throw new Error("GitLab URL must point to a directory that contains SKILL.md.");
    }
    entries.push(...payload as Array<{ type?: string; path?: string; mode?: string }>);
    page = response.headers.get("x-next-page")?.trim() ?? "";
    if (page && !/^\d+$/.test(page)) {
      throw new Error("GitLab directory listing returned an invalid pagination cursor.");
    }
  }

  const blobEntries = entries.filter((entry) => entry.type === "blob" && typeof entry.path === "string");
  if (blobEntries.length > MAX_SKILL_PACKAGE_FILES) {
    throw new Error(`GitLab skill contains more than ${MAX_SKILL_PACKAGE_FILES} files.`);
  }

  const files: ImportedSkillFile[] = [];
  const prefix = pointer.path ? `${pointer.path.replace(/\/+$/, "")}/` : "";
  for (const entry of entries) {
    if (!entry.path || !entry.type || entry.type === "tree") {
      continue;
    }
    if (entry.type !== "blob") {
      warnings.push(`Skipped unsupported GitLab entry: ${entry.path}`);
      continue;
    }
    if (prefix && !entry.path.startsWith(prefix)) {
      throw new Error(`GitLab directory listing returned an entry outside the requested path: ${entry.path}`);
    }
    const rawRelativePath = prefix ? entry.path.slice(prefix.length) : entry.path;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitLab skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const bytes = await fetchGitLabRawFile({ ...pointer, path: entry.path }, budget, workspaceId);
    assertSkillSourceFileBudget(budget, pathResult.normalized, bytes, "GitLab skill");
    files.push({
      path: pathResult.normalized,
      bytes,
      ...(entry.mode === "100755" ? { mode: "0755" } : entry.mode === "100644" ? { mode: "0644" } : {}),
    });
  }

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error("Imported GitLab skill must contain SKILL.md.");
  }
  return sortImportedSkillFiles(files);
}
export async function fetchGitLabRawFile(
  pointer: GitLabDirectoryPointer,
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<Uint8Array> {
  assertSkillSourceRequestBudget(budget, "GitLab skill");
  const ref = pointer.resolvedSha ?? pointer.ref;
  const response = await fetch(
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(pointer.projectPath)}/repository/files/${encodeURIComponent(pointer.path)}/raw?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch GitLab skill file "${pointer.path}": ${response.status}`);
  }
  return readResponseBytesWithLimit(response, MAX_SKILL_SINGLE_FILE_BYTES, `GitLab skill file "${pointer.path}"`);
}
export function assertSkillSourceRequestBudget(budget: SkillSourceBudget, sourceLabel: string): void {
  budget.requestCount += 1;
  if (budget.requestCount > MAX_SKILL_SOURCE_REQUESTS) {
    throw new Error(`${sourceLabel} requires more than ${MAX_SKILL_SOURCE_REQUESTS} remote requests.`);
  }
}
export function assertSkillSourceFileBudget(
  budget: SkillSourceBudget,
  path: string,
  bytes: Uint8Array,
  sourceLabel: string,
): void {
  const pathResult = classifySkillFilePath(path);
  if (!pathResult.ok) {
    throw new Error(`${sourceLabel} contains unsafe path "${path}": ${pathResult.message}`);
  }
  if (pathResult.depth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
    throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
  }
  if (bytes.byteLength > MAX_SKILL_SINGLE_FILE_BYTES) {
    throw new Error(`${sourceLabel} file "${path}" exceeds the ${MAX_SKILL_SINGLE_FILE_BYTES} byte single-file limit.`);
  }
  budget.fileCount += 1;
  budget.totalBytes += bytes.byteLength;
  if (budget.fileCount > MAX_SKILL_PACKAGE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_PACKAGE_FILES} files.`);
  }
  if (budget.totalBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new Error(`${sourceLabel} exceeds the ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} byte total content limit.`);
  }
}
