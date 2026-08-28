// 技能导入的GitHub/GitLab URL 解析（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { parseUrl } from "./http-shared.ts";
import type { GitHubDirectoryPointer, GitLabDirectoryPointer } from "./types.ts";

export function parseGitHubDirectoryUrl(sourceUrl: string): GitHubDirectoryPointer | null {
  const parsed = parseUrl(sourceUrl);
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }

  if (parsed.hostname === "github.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && (parts[2] === "tree" || parts[2] === "blob")) {
      const [owner, repo, _kind, ref, ...rest] = parts;
      return {
        owner,
        repo,
        ref,
        path: rest.join("/"),
      };
    }
  }

  if (parsed.hostname === "raw.githubusercontent.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 4) {
      const [owner, repo, ref, ...rest] = parts;
      return {
        owner,
        repo,
        ref,
        path: rest.join("/"),
      };
    }
  }

  return null;
}
export function parseGitHubRepositoryUrl(sourceUrl: string): { owner: string; repo: string } | null {
  const parsed = parseUrl(sourceUrl);
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}
export function parseGitLabDirectoryUrl(sourceUrl: string): GitLabDirectoryPointer | null {
  const parsed = parseUrl(sourceUrl);
  if (!parsed || parsed.hostname !== "gitlab.com") {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const separatorIndex = parts.indexOf("-");
  if (separatorIndex < 2 || separatorIndex + 3 > parts.length) {
    return null;
  }
  const kind = parts[separatorIndex + 1];
  if (kind !== "tree" && kind !== "blob" && kind !== "raw") {
    return null;
  }

  const projectSegments = parts.slice(0, separatorIndex);
  const rawRef = parts[separatorIndex + 2];
  if (!rawRef) {
    return null;
  }
  const repoIndex = projectSegments.length - 1;
  projectSegments[repoIndex] = projectSegments[repoIndex]!.replace(/\.git$/i, "");
  if (projectSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  try {
    return {
      projectPath: projectSegments.map((segment) => decodeURIComponent(segment)).join("/"),
      ref: decodeURIComponent(rawRef),
      path: parts.slice(separatorIndex + 3).map((segment) => decodeURIComponent(segment)).join("/"),
    };
  } catch {
    return null;
  }
}
