// 技能导入的原始文件抓取、响应限额与编解码工具（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { normalizeSkillFilePath, sameValue } from "../../shared/helpers.ts";
import { gitAuthHeadersSync } from "../git-credentials.ts";
import { MAX_SKILL_SINGLE_FILE_BYTES } from "../package/archive-limits.ts";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { assertSkillSourceRequestBudget } from "./fetch-gitlab.ts";
import { GITHUB_RAW_DOWNLOAD_TIMEOUT_MS, MAX_SKILL_SOURCE_METADATA_BYTES, SkillGitHubImportError } from "./types.ts";
import type { GitHubDirectoryPointer, ImportedSkillFile, SkillSourceBudget } from "./types.ts";

export async function fetchGitHubRawFile(pointer: GitHubDirectoryPointer, workspaceId?: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await fetchGitHubRawFileBytes(pointer, { workspaceId }),
  );
}
export async function fetchGitHubRawFileBytes(
  pointer: GitHubDirectoryPointer,
  options: {
    workspaceId?: string;
    fallbackBudget?: SkillSourceBudget;
    expectedBlobSha?: string;
    expectedSize?: number;
  } = {},
): Promise<Uint8Array> {
  const { workspaceId, fallbackBudget, expectedBlobSha, expectedSize } = options;
  const ref = pointer.resolvedSha ?? pointer.ref;
  let response: Response | undefined;
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/${pointer.owner}/${pointer.repo}/${ref}/${pointer.path}`,
      {
        headers: {
          "User-Agent": "DofeAgent/0.1.0",
          ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
        },
        signal: AbortSignal.timeout(GITHUB_RAW_DOWNLOAD_TIMEOUT_MS),
      },
    );
  } catch {
    response = undefined;
  }
  if (response?.ok) {
    const bytes = await readResponseBytesWithLimit(response, MAX_SKILL_SINGLE_FILE_BYTES, "GitHub skill file");
    if (matchesGitHubFileIntegrity(bytes, { expectedBlobSha, expectedSize })) {
      return bytes;
    }
  }

  if (fallbackBudget) {
    assertSkillSourceRequestBudget(fallbackBudget, "GitHub skill");
  }
  return fetchGitHubContentsFileBytes(pointer, workspaceId, { expectedBlobSha, expectedSize });
}
export async function fetchGitHubContentsFileBytes(
  pointer: GitHubDirectoryPointer,
  workspaceId?: string,
  expected: { expectedBlobSha?: string; expectedSize?: number } = {},
): Promise<Uint8Array> {
  const ref = pointer.resolvedSha ?? pointer.ref;
  const response = await fetch(buildGitHubContentsApiUrl(pointer.owner, pointer.repo, pointer.path, ref), {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
    signal: AbortSignal.timeout(GITHUB_RAW_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    // The file was already enumerated in a SHA-locked tree, so a miss here is
    // a transfer failure (the raw fetch above failed too) — not "wrong URL".
    throw new SkillGitHubImportError(
      "skill.github.file_download_failed",
      `Failed to fetch GitHub skill file "${pointer.path}": ${response.status}`,
    );
  }
  const payload = await readResponseJsonWithLimit(
    response,
    Math.ceil(MAX_SKILL_SINGLE_FILE_BYTES * 1.5) + MAX_SKILL_SOURCE_METADATA_BYTES,
    `GitHub skill file "${pointer.path}"`,
  ) as {
    type?: string;
    encoding?: string;
    content?: string;
    sha?: string;
    size?: number;
  };
  if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`GitHub skill file "${pointer.path}" is not a supported file.`);
  }
  const bytes = new Uint8Array(Buffer.from(payload.content.replace(/\n/g, ""), "base64"));
  if (!matchesGitHubFileIntegrity(bytes, {
    expectedBlobSha: expected.expectedBlobSha ?? payload.sha,
    expectedSize: expected.expectedSize ?? payload.size,
  })) {
    throw new SkillGitHubImportError(
      "skill.github.file_download_failed",
      `GitHub skill file "${pointer.path}" did not match its immutable blob metadata.`,
    );
  }
  return bytes;
}
export async function readResponseJsonWithLimit(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, maxBytes, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}
export async function readResponseTextWithLimit(response: Response, maxBytes: number, label: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readResponseBytesWithLimit(response, maxBytes, label),
  );
}
export async function readResponseBytesWithLimit(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new Error(`${label} returned an invalid Content-Length header.`);
    }
    if (declaredBytes > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function buildGitHubContentsApiUrl(owner: string, repo: string, path: string, ref: string): string {
  const normalizedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const pathSuffix = normalizedPath ? `/${normalizedPath}` : "";
  return `https://api.github.com/repos/${owner}/${repo}/contents${pathSuffix}?ref=${encodeURIComponent(ref)}`;
}
export function extractClawHubDownloadUrl(html: string): string | null {
  const match = html.match(/https:\/\/[^"']+convex\.site\/api\/v1\/download\?slug=[^"'<\s]+/i);
  return match ? match[0] : null;
}
export function deriveSkillNameFromPath(path: string): string {
  const normalized = normalizeSkillFilePath(path);
  const segments = normalized.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - (sameValue(segments[segments.length - 1] ?? "", "SKILL.md") ? 2 : 1)] : "";
  return base || basename(path).replace(/\.md$/i, "") || "Imported Skill";
}
export function readSkillMarkdown(files: ImportedSkillFile[]): string {
  const match = files.find((file) => sameValue(file.path, "SKILL.md"));
  if (!match) {
    throw new Error("Imported skill is missing required file \"SKILL.md\".");
  }
  return decodeUtf8(match.bytes);
}
export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
export function encodeUtf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}
export function matchesGitHubFileIntegrity(
  bytes: Uint8Array,
  expected: { expectedBlobSha?: string; expectedSize?: number },
): boolean {
  const expectedSize = expected.expectedSize;
  if (Number.isSafeInteger(expectedSize) && expectedSize !== undefined && expectedSize >= 0 && bytes.byteLength !== expectedSize) {
    return false;
  }
  const blobSha = expected.expectedBlobSha?.trim().toLowerCase();
  if (!blobSha || !/^[a-f0-9]{40}$/.test(blobSha)) {
    return true;
  }
  const actual = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  return actual === blobSha;
}
export function joinRelative(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}
export function sortImportedSkillFiles(files: ImportedSkillFile[]): ImportedSkillFile[] {
  return [...files].sort((left, right) => {
    if (sameValue(left.path, "SKILL.md")) {
      return -1;
    }
    if (sameValue(right.path, "SKILL.md")) {
      return 1;
    }
    return left.path.localeCompare(right.path, "en-US");
  });
}
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
export function parseJsonSafely(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
export function readResolvedRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const resolvedRef = (value as Record<string, unknown>).resolvedRef;
  return typeof resolvedRef === "string" && /^[a-f0-9]{40}$/i.test(resolvedRef.trim())
    ? resolvedRef.trim().toLowerCase()
    : undefined;
}
