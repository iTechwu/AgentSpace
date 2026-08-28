import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";

export const STATE_DIR = "data";

export function createOpaqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueNames(values: string[]): string[] {
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (result.some((existing) => sameValue(existing, trimmed))) {
      continue;
    }
    result.push(trimmed);
  }

  return result;
}

export function uniqueStringValues(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || result.includes(trimmed)) {
      continue;
    }
    result.push(trimmed);
  }
  return result;
}

export function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "material";
}

export function nowTime(): string {
  return new Date().toISOString();
}

export function formatTimeOfDay(value: string | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "";
  }

  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function sameValue(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

export function resolveRepositoryRoot(): string {
  const candidates = [
    process.env.DOFE_AGENT_REPOSITORY_ROOT,
    /*turbopackIgnore: true*/ process.cwd(),
    join(/*turbopackIgnore: true*/ process.cwd(), ".."),
    join(/*turbopackIgnore: true*/ process.cwd(), "..", ".."),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(/*turbopackIgnore: true*/ join(resolved, "Target.md"))) {
      return resolved;
    }
  }

  return /*turbopackIgnore: true*/ process.cwd();
}

export function sanitizeAttachmentFileName(value: string): string {
  const trimmed = basename(value.trim().replace(/\\/g, "/"));
  const extension = extname(trimmed);
  const stem = extension ? trimmed.slice(0, -extension.length) : trimmed;
  const safeStem = stem
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeExtension = extension.replace(/[^a-zA-Z0-9.]+/g, "").toLowerCase();

  return `${safeStem || "attachment"}${safeExtension}`;
}

export function inferAttachmentMediaType(fileName: string, inputMediaType?: string): string {
  if (inputMediaType && inputMediaType.trim().length > 0) {
    return inputMediaType.trim();
  }

  const extension = extname(fileName).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".md") {
    return "text/markdown";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".pdf") {
    return "application/pdf";
  }
  return "application/octet-stream";
}

export function resolveAttachmentMediaType(fileName: string, inputMediaType?: string): string {
  const trimmed = inputMediaType?.trim();
  if (trimmed && trimmed !== "application/octet-stream") {
    return trimmed;
  }

  return inferAttachmentMediaType(fileName);
}

export function inferAttachmentKind(mediaType: string): MessageAttachment["kind"] {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/") ? "image" : "file";
}

export function normalizeSkillFilePath(path: unknown): string {
  if (typeof path !== "string") {
    return "";
  }

  const normalized = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  return normalized;
}

export function normalizeSkillIds(skillIds: unknown, skills: Array<{ id: string }>): string[] {
  if (!Array.isArray(skillIds)) {
    return [];
  }

  const result: string[] = [];
  for (const skillId of skillIds) {
    if (typeof skillId !== "string" || skillId.trim().length === 0) {
      continue;
    }
    if (!skills.some((skill) => skill.id === skillId.trim())) {
      continue;
    }
    if (result.includes(skillId.trim())) {
      continue;
    }
    result.push(skillId.trim());
  }

  return result;
}

export function readSkillFileContent(skill: { files: Array<{ path: string; content: string }> }, path: string): string {
  return skill.files.find((file) => sameValue(file.path, path))?.content ?? "";
}
