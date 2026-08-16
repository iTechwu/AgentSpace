// 技能导入的GitHub 目录/文件抓取（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { sameValue } from "../../shared/helpers.ts";
import { gitAuthHeadersSync } from "../git-credentials.ts";
import { classifySkillFilePath } from "../package/path-safety.ts";
import { assertSkillSourceFileBudget, assertSkillSourceRequestBudget } from "./fetch-gitlab.ts";
import { buildGitHubContentsApiUrl, fetchGitHubRawFileBytes, joinRelative, readResponseJsonWithLimit, sortImportedSkillFiles } from "./http-shared.ts";
import { GITHUB_RAW_DOWNLOAD_CONCURRENCY, MAX_SKILL_SOURCE_METADATA_BYTES, SkillGitHubImportError, skillGitHubHttpError } from "./types.ts";
import type { GitHubDirectoryPointer, ImportedSkillFile, SkillSourceBudget } from "./types.ts";

export async function fetchGitHubDirectoryFiles(
  pointer: GitHubDirectoryPointer,
  warnings: string[],
  options: {
    relativePrefix?: string;
    requireSkillFile?: boolean;
    budget?: SkillSourceBudget;
    workspaceId?: string;
  } = {},
): Promise<ImportedSkillFile[]> {
  const {
    relativePrefix = "",
    requireSkillFile = true,
    budget = { fileCount: 0, totalBytes: 0, requestCount: 0 },
    workspaceId,
  } = options;
  assertSkillSourceRequestBudget(budget, "GitHub skill");
  const ref = pointer.resolvedSha ?? pointer.ref;
  const contentsUrl = buildGitHubContentsApiUrl(pointer.owner, pointer.repo, pointer.path, ref);
  const response = await fetch(contentsUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to fetch GitHub skill directory ${pointer.path || "/"}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub directory listing",
  ) as Array<{
    type?: string;
    name?: string;
    path?: string;
    download_url?: string | null;
    sha?: string;
    size?: number;
  }> | { type?: string };
  if (!Array.isArray(payload)) {
    throw new SkillGitHubImportError(
      "skill.github.no_skill",
      "GitHub URL must point to a directory that contains SKILL.md.",
    );
  }

  const files: ImportedSkillFile[] = [];
  for (const entry of payload) {
    if (!entry.path || !entry.name || !entry.type) {
      continue;
    }

    const rawRelativePath = joinRelative(relativePrefix, entry.name);
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitHub skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const relativePath = pathResult.normalized;

    if (entry.type === "dir") {
      const nestedPointer: GitHubDirectoryPointer = {
        ...pointer,
        path: entry.path,
      };
      files.push(...await fetchGitHubDirectoryFiles(nestedPointer, warnings, {
        relativePrefix: relativePath,
        requireSkillFile: false,
        budget,
        workspaceId,
      }));
      continue;
    }

    if (entry.type !== "file") {
      warnings.push(`Skipped unsupported GitHub entry: ${entry.path}`);
      continue;
    }

    assertSkillSourceRequestBudget(budget, "GitHub skill");
    const bytes = await fetchGitHubRawFileBytes(
      { ...pointer, path: entry.path },
      {
        workspaceId,
        fallbackBudget: budget,
        expectedBlobSha: entry.sha,
        expectedSize: entry.size,
      },
    );
    assertSkillSourceFileBudget(budget, relativePath, bytes, "GitHub skill");
    files.push({
      path: relativePath,
      bytes,
    });
  }

  if (requireSkillFile && !files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new SkillGitHubImportError("skill.github.no_skill", "Imported GitHub skill must contain SKILL.md.");
  }

  return sortImportedSkillFiles(files);
}
export async function fetchDiscoveredGitHubFiles(
  pointer: GitHubDirectoryPointer,
  warnings: string[],
  workspaceId?: string,
): Promise<ImportedSkillFile[]> {
  const budget: SkillSourceBudget = {
    fileCount: 0,
    totalBytes: 0,
    requestCount: pointer.discoveryRequestCount ?? 0,
  };
  const prefix = pointer.path ? `${pointer.path.replace(/\/+$/, "")}/` : "";
  const downloadEntries: Array<{
    entry: { path: string; mode?: string; sha?: string; size?: number };
    relativePath: string;
  }> = [];

  for (const entry of pointer.discoveredFiles ?? []) {
    if (entry.mode && entry.mode !== "100644" && entry.mode !== "100755") {
      warnings.push(`Skipped unsupported GitHub entry: ${entry.path}`);
      continue;
    }
    if (prefix && !entry.path.startsWith(prefix)) {
      throw new Error(`GitHub repository tree returned an entry outside the selected skill path: ${entry.path}`);
    }
    const rawRelativePath = prefix ? entry.path.slice(prefix.length) : entry.path;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitHub skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }

    assertSkillSourceRequestBudget(budget, "GitHub skill");
    downloadEntries.push({
      entry,
      relativePath: pathResult.normalized,
    });
  }

  const files = await mapWithConcurrency(
    downloadEntries,
    GITHUB_RAW_DOWNLOAD_CONCURRENCY,
    async ({ entry, relativePath }) => {
      const bytes = await fetchGitHubRawFileBytes(
        { ...pointer, path: entry.path },
        {
          workspaceId,
          fallbackBudget: budget,
          expectedBlobSha: entry.sha,
          expectedSize: entry.size,
        },
      );
      assertSkillSourceFileBudget(budget, relativePath, bytes, "GitHub skill");
      return {
        path: relativePath,
        bytes,
        ...(entry.mode === "100755" ? { mode: "0755" } : entry.mode === "100644" ? { mode: "0644" } : {}),
      };
    },
  );

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error("Imported GitHub skill must contain SKILL.md.");
  }
  return sortImportedSkillFiles(files);
}
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  if (failed) {
    throw firstError;
  }
  return results;
}
