"use server";

import { cache } from "react";
import { getCurrentUser } from "./server-auth";
import { readWorkspaceSelectionState } from "./workspace-selection";
import {
  resolveCurrentWorkspaceContextForUserSync,
  resolveWorkspaceAccessForIdentifierSync,
  type CurrentWorkspaceContext,
  type WorkspaceAccessResolution,
} from "./server-workspace-resolver";

export const getCurrentWorkspaceContext = cache(async (): Promise<CurrentWorkspaceContext | null> => {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return null;
  }

  const selectionState = await readWorkspaceSelectionState();
  const preferredWorkspaceIdentifiers = selectionState.current
    ? [selectionState.current, ...selectionState.recent]
    : selectionState.recent;
  return resolveCurrentWorkspaceContextForUserSync(currentUser, preferredWorkspaceIdentifiers);
});

export async function requireCurrentWorkspaceContext(): Promise<CurrentWorkspaceContext> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized.");
  }

  return context;
}

export const getWorkspaceContextForIdentifier = cache(async function getWorkspaceContextForIdentifier(
  workspaceIdentifier: string,
): Promise<CurrentWorkspaceContext | null> {
  const resolution = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  return resolution.status === "ok" ? resolution.context : null;
});

export const getWorkspaceAccessForIdentifier = cache(async function getWorkspaceAccessForIdentifier(
  workspaceIdentifier: string,
): Promise<WorkspaceAccessResolution> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { status: "unauthenticated" };
  }

  return resolveWorkspaceAccessForIdentifierSync(currentUser, workspaceIdentifier);
});
