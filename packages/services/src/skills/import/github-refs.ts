// 技能导入的GitHub ref/指针解析与 slug 归一（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { sameValue } from "../../shared/helpers.ts";
import { gitAuthHeadersSync } from "../git-credentials.ts";
import { MAX_SKILL_SINGLE_FILE_BYTES } from "../package/archive-limits.ts";
import { basename, resolve } from "node:path";
import { assertSkillSourceRequestBudget } from "./fetch-gitlab.ts";
import { readResponseJsonWithLimit } from "./http-shared.ts";
import { parseGitHubDirectoryUrl, parseGitHubRepositoryUrl } from "./source-parsers.ts";
import { MAX_SKILL_SOURCE_METADATA_BYTES, SkillGitHubImportError, skillGitHubHttpError } from "./types.ts";
import type { GitHubDirectoryPointer, SkillSourceBudget } from "./types.ts";

export async function fetchGitHubDefaultBranch(owner: string, repo: string, workspaceId?: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to fetch GitHub repository metadata for ${owner}/${repo}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub repository metadata",
  ) as { default_branch?: string };
  return payload.default_branch?.trim() || "main";
}
export async function resolveGitHubRefToSha(owner: string, repo: string, ref: string, workspaceId?: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to resolve GitHub ref "${ref}" for ${owner}/${repo}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub commit metadata",
  ) as { sha?: string };
  const sha = payload.sha?.trim().toLowerCase();
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error(`GitHub commit response did not contain a valid SHA for ref "${ref}".`);
  }
  return sha;
}
export async function resolveGitLabRefToSha(
  projectPath: string,
  ref: string,
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<string> {
  assertSkillSourceRequestBudget(budget, "GitLab skill");
  const response = await fetch(
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(ref)}`,
    {
      headers: {
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve GitLab ref "${ref}" to commit SHA: ${response.status}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitLab commit metadata",
  ) as { id?: string };
  const sha = payload.id?.trim().toLowerCase();
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error(`GitLab commit response did not contain a valid SHA for ref "${ref}".`);
  }
  return sha;
}
export async function resolveGitHubSkillPointerBySlug(input: {
  owner: string;
  repo: string;
  ref: string;
  skillSlug: string;
  workspaceId?: string;
}): Promise<GitHubDirectoryPointer> {
  const resolvedSha = await resolveGitHubRefToSha(input.owner, input.repo, input.ref, input.workspaceId);
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/trees/${resolvedSha}?recursive=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(input.workspaceId ? gitAuthHeadersSync(input.workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to inspect GitHub repository tree for ${input.owner}/${input.repo}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SINGLE_FILE_BYTES,
    "GitHub repository tree",
  ) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const skillCandidates = (payload.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path!)
    .filter((path) => sameValue(basename(path), "SKILL.md"))
    .map((path) => path.slice(0, -"/SKILL.md".length))
    .filter((path) => path.split("/").some((segment) => sameSkillSlug(segment, input.skillSlug)))
    .sort((left, right) => left.length - right.length);

  const matchedPath = skillCandidates[0];
  if (!matchedPath) {
    throw new Error(`Could not find a skill directory for "${input.skillSlug}" in ${input.owner}/${input.repo}.`);
  }

  return {
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    path: matchedPath,
    resolvedSha,
  };
}

/**
 * Single GitHub source classification + SHA resolution path shared by the
 * import flow ({@link resolveGitHubSkillPointer}) and the update-check flow
 * ({@link resolveGitHubSourceSha}). A direct tree/blob/raw URL resolves its
 * own ref; a bare repository URL resolves the default branch first. Both
 * callers previously re-implemented this sequence — duplicated code that was
 * free to drift (a URL-classification or SHA-validation fix landing in one
 * flow silently missing the other). Returns `null` for non-GitHub URLs.
 */
export async function resolveGitHubPointerWithSha(
  sourceUrl: string,
  workspaceId?: string,
): Promise<GitHubDirectoryPointer | null> {
  const directPointer = parseGitHubDirectoryUrl(sourceUrl);
  if (directPointer) {
    directPointer.resolvedSha = await resolveGitHubRefToSha(
      directPointer.owner,
      directPointer.repo,
      directPointer.ref,
      workspaceId,
    );
    return directPointer;
  }

  const repository = parseGitHubRepositoryUrl(sourceUrl);
  if (!repository) {
    return null;
  }
  const ref = await fetchGitHubDefaultBranch(repository.owner, repository.repo, workspaceId);
  const resolvedSha = await resolveGitHubRefToSha(repository.owner, repository.repo, ref, workspaceId);
  return {
    ...repository,
    ref,
    path: "",
    resolvedSha,
  };
}
export async function resolveGitHubSkillPointer(
  sourceUrl: string,
  workspaceId?: string,
): Promise<GitHubDirectoryPointer | null> {
  // Direct tree/blob/raw URLs come back fully resolved (path included). Only a
  // bare repository URL needs skill discovery against the recursive tree.
  const base = await resolveGitHubPointerWithSha(sourceUrl, workspaceId);
  if (!base || base.path) {
    return base;
  }
  const repository = { owner: base.owner, repo: base.repo };
  const ref = base.ref;
  const resolvedSha = base.resolvedSha!;
  const response = await fetch(
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${resolvedSha}?recursive=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to inspect GitHub repository tree for ${repository.owner}/${repository.repo}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SINGLE_FILE_BYTES,
    "GitHub repository tree",
  ) as {
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; mode?: string; sha?: string; size?: number }>;
  };
  if (payload.truncated) {
    throw new SkillGitHubImportError(
      "skill.github.tree_truncated",
      `GitHub repository tree is too large to discover a unique skill safely in ${repository.owner}/${repository.repo}; use a tree URL for one skill directory.`,
    );
  }
  const treeEntries = payload.tree ?? [];
  const skillPaths = treeEntries
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path!)
    .filter((path) => sameValue(basename(path), "SKILL.md"))
    .map((path) => sameValue(path, "SKILL.md") ? "" : path.slice(0, -"/SKILL.md".length))
    .sort((left, right) => left.localeCompare(right));

  if (skillPaths.length === 0) {
    throw new SkillGitHubImportError(
      "skill.github.no_skill",
      `GitHub repository ${repository.owner}/${repository.repo} does not contain SKILL.md.`,
    );
  }
  if (skillPaths.length > 1) {
    // Fail closed with the candidate directories on the error payload — the
    // UI can offer a choice; until then the specific tree URL is the remedy.
    throw new SkillGitHubImportError(
      "skill.github.multiple_skills",
      `GitHub repository ${repository.owner}/${repository.repo} contains multiple skills; use a tree URL for one skill directory.`,
      { candidates: skillPaths },
    );
  }
  return {
    ...repository,
    ref,
    path: skillPaths[0]!,
    resolvedSha,
    discoveryRequestCount: 3,
    discoveredFiles: treeEntries
      .filter((entry): entry is { path: string; type?: string; mode?: string; sha?: string; size?: number } => (
        entry.type === "blob" && typeof entry.path === "string"
      ))
      .filter((entry) => {
        const prefix = skillPaths[0] ? `${skillPaths[0]}/` : "";
        return !prefix || entry.path.startsWith(prefix);
      })
      .map((entry) => ({
        path: entry.path,
        ...(entry.mode ? { mode: entry.mode } : {}),
        ...(entry.sha ? { sha: entry.sha } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      })),
  };
}
export async function resolveGitHubSourceSha(sourceUrl: string, workspaceId?: string): Promise<string | null> {
  const resolved = await resolveGitHubPointerWithSha(sourceUrl, workspaceId);
  return resolved?.resolvedSha ?? null;
}
export function sameSkillSlug(left: string, right: string): boolean {
  return normalizeSkillSlug(left) === normalizeSkillSlug(right);
}
export function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/&amp;/g, "&")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
