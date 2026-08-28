"use server";

import { cache } from "react";
import { cookies } from "next/headers";
import {
  WORKSPACE_RECENT_SELECTION_COOKIE,
  WORKSPACE_SELECTION_COOKIE,
} from "./workspace-selection-constants";

const MAX_RECENT_WORKSPACES = 8;

export async function readWorkspaceSelectionCookie(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const value = cookieStore.get(WORKSPACE_SELECTION_COOKIE)?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}

export async function readRecentWorkspaceSelectionCookie(): Promise<string[]> {
  const cookieStore = await cookies();
  return parseRecentWorkspaceIdentifiers(cookieStore.get(WORKSPACE_RECENT_SELECTION_COOKIE)?.value);
}

export const readWorkspaceSelectionState = cache(async function readWorkspaceSelectionState(): Promise<{
  current?: string;
  recent: string[];
}> {
  const current = await readWorkspaceSelectionCookie();
  const recent = await readRecentWorkspaceSelectionCookie();
  return {
    current,
    recent: current ? dedupeWorkspaceIdentifiers([current, ...recent]) : recent,
  };
});

export async function writeWorkspaceSelectionCookie(workspaceIdentifier: string): Promise<void> {
  const trimmedWorkspaceIdentifier = normalizeWorkspaceIdentifier(workspaceIdentifier);
  if (!trimmedWorkspaceIdentifier) {
    throw new Error("workspaceIdentifier is required.");
  }

  const cookieStore = await cookies();
  const nextRecent = dedupeWorkspaceIdentifiers([
    trimmedWorkspaceIdentifier,
    ...parseRecentWorkspaceIdentifiers(cookieStore.get(WORKSPACE_RECENT_SELECTION_COOKIE)?.value),
  ]).slice(0, MAX_RECENT_WORKSPACES);

  cookieStore.set(WORKSPACE_SELECTION_COOKIE, trimmedWorkspaceIdentifier, {
    httpOnly: true,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  cookieStore.set(WORKSPACE_RECENT_SELECTION_COOKIE, nextRecent.join(","), {
    httpOnly: true,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

export async function clearWorkspaceSelectionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_SELECTION_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  cookieStore.set(WORKSPACE_RECENT_SELECTION_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

function parseRecentWorkspaceIdentifiers(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return dedupeWorkspaceIdentifiers(
    value
      .split(",")
      .map((item) => normalizeWorkspaceIdentifier(item))
      .filter((item): item is string => item !== undefined),
  ).slice(0, MAX_RECENT_WORKSPACES);
}

function dedupeWorkspaceIdentifiers(identifiers: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const identifier of identifiers) {
    if (!seen.has(identifier)) {
      seen.add(identifier);
      result.push(identifier);
    }
  }

  return result;
}

function normalizeWorkspaceIdentifier(workspaceIdentifier: string): string | undefined {
  const trimmedWorkspaceIdentifier = workspaceIdentifier.trim();
  return trimmedWorkspaceIdentifier.length > 0 ? trimmedWorkspaceIdentifier : undefined;
}
