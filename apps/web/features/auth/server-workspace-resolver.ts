import {
  listActiveSsoWorkspacesSync,
  listChannelParticipantsForUserSync,
  listUserWorkspacesSync,
  readWorkspaceSync,
  type StoredWorkspaceMembershipRecord,
  type StoredWorkspaceRecord,
} from "@dofe-agent/db";
import type { AuthUser } from "./server-auth";

export interface CurrentWorkspaceContext {
  currentUser: AuthUser;
  currentWorkspace: StoredWorkspaceRecord;
  currentMembership: StoredWorkspaceMembershipRecord;
  memberships: StoredWorkspaceMembershipRecord[];
  workspaces: StoredWorkspaceRecord[];
  accessScope?: "workspace" | "channel";
  channelNames?: string[];
}

export type WorkspaceAccessResolution =
  | { status: "unauthenticated" }
  | { status: "not_found" }
  | { status: "forbidden"; currentUser: AuthUser; workspaces: StoredWorkspaceRecord[] }
  | { status: "ok"; context: CurrentWorkspaceContext };

export function resolveCurrentWorkspaceContextForUserSync(
  currentUser: AuthUser,
  selectedWorkspaceId?: string | readonly string[],
): CurrentWorkspaceContext {
  const preferredWorkspaceIdentifiers = normalizePreferredWorkspaceIdentifiers(selectedWorkspaceId);
  const memberships = ensureWorkspaceMembershipsSync(currentUser);

  const preferredWorkspace =
    preferredWorkspaceIdentifiers
    .map((workspaceIdentifier) => readWorkspaceSync(workspaceIdentifier))
    .find((workspace) => workspace && memberships.some((membership) => membership.workspaceId === workspace.id))
    ?? null;
  if (!preferredWorkspace) {
    const channelWorkspace = preferredWorkspaceIdentifiers
      .map((workspaceIdentifier) => readWorkspaceSync(workspaceIdentifier))
      .find((workspace): workspace is StoredWorkspaceRecord => {
        if (!workspace) {
          return false;
        }
        return listChannelParticipantsForUserSync(workspace.id, currentUser.id, { statuses: ["active"] }).length > 0;
      });
    if (channelWorkspace) {
      return buildChannelScopedWorkspaceContext(currentUser, channelWorkspace, memberships, preferredWorkspaceIdentifiers);
    }
  }
  if (memberships.length === 0) {
    throw new Error("auth.sso_no_workspace");
  }
  const currentMembership =
    (preferredWorkspace
      ? memberships.find((membership) => membership.workspaceId === preferredWorkspace.id)
      : undefined)
    ?? memberships[0]!;
  const currentWorkspace =
    readWorkspaceSync(currentMembership.workspaceId)
    ?? (() => { throw new Error("auth.sso_no_workspace"); })();
  const workspaces = sortWorkspacesByPreferredIdentifiers(
    memberships
    .map((membership) => readWorkspaceSync(membership.workspaceId))
    .filter((workspace): workspace is StoredWorkspaceRecord => workspace !== null),
    [currentWorkspace.id, currentWorkspace.slug, ...preferredWorkspaceIdentifiers],
  );

  return {
    currentUser,
    currentWorkspace,
    currentMembership,
    memberships,
    workspaces,
    accessScope: "workspace",
  };
}

export function resolveWorkspaceContextForIdentifierSync(
  currentUser: AuthUser,
  workspaceIdentifier: string,
): CurrentWorkspaceContext | null {
  const resolution = resolveWorkspaceAccessForIdentifierSync(currentUser, workspaceIdentifier);
  return resolution.status === "ok" ? resolution.context : null;
}

export function resolveWorkspaceAccessForIdentifierSync(
  currentUser: AuthUser,
  workspaceIdentifier: string,
): WorkspaceAccessResolution {
  const memberships = ensureWorkspaceMembershipsSync(currentUser);

  const workspace = readWorkspaceSync(workspaceIdentifier);
  if (!workspace) {
    return { status: "not_found" };
  }

  const currentMembership = memberships.find((membership) => membership.workspaceId === workspace.id);
  const workspaces = memberships
    .map((membership) => readWorkspaceSync(membership.workspaceId))
    .filter((item): item is StoredWorkspaceRecord => item !== null);

  if (!currentMembership) {
    const channelParticipants = listChannelParticipantsForUserSync(workspace.id, currentUser.id, { statuses: ["active"] });
    if (channelParticipants.length > 0) {
      return {
        status: "ok",
        context: buildChannelScopedWorkspaceContext(currentUser, workspace, memberships, [workspace.id, workspace.slug]),
      };
    }

    return {
      status: "forbidden",
      currentUser,
      workspaces,
    };
  }

  return {
    status: "ok",
    context: {
      currentUser,
      currentWorkspace: workspace,
      currentMembership,
      memberships,
      workspaces,
      accessScope: "workspace",
    },
  };
}

function buildChannelScopedWorkspaceContext(
  currentUser: AuthUser,
  workspace: StoredWorkspaceRecord,
  memberships: StoredWorkspaceMembershipRecord[],
  preferredWorkspaceIdentifiers: readonly string[],
): CurrentWorkspaceContext {
  const channelParticipants = listChannelParticipantsForUserSync(workspace.id, currentUser.id, { statuses: ["active"] });
  const memberWorkspaces = memberships
    .map((membership) => readWorkspaceSync(membership.workspaceId))
    .filter((item): item is StoredWorkspaceRecord => item !== null && item.id !== workspace.id);

  return {
    currentUser,
    currentWorkspace: workspace,
    currentMembership: {
      id: `channel-guest-${workspace.id}-${currentUser.id}`,
      workspaceId: workspace.id,
      userId: currentUser.id,
      role: "member",
      status: "active",
      joinedAt: channelParticipants[0]?.joinedAt ?? new Date(0).toISOString(),
    },
    memberships,
    workspaces: sortWorkspacesByPreferredIdentifiers(
      [workspace, ...memberWorkspaces],
      [workspace.id, workspace.slug, ...preferredWorkspaceIdentifiers],
    ),
    accessScope: "channel",
    channelNames: channelParticipants.map((participant) => participant.channelName),
  };
}

function normalizePreferredWorkspaceIdentifiers(selectedWorkspaceId?: string | readonly string[]): string[] {
  if (typeof selectedWorkspaceId === "string") {
    const trimmedWorkspaceId = selectedWorkspaceId.trim();
    return trimmedWorkspaceId.length > 0 ? [trimmedWorkspaceId] : [];
  }

  if (!selectedWorkspaceId) {
    return [];
  }

  const normalizedIdentifiers: string[] = [];
  for (const workspaceIdentifier of selectedWorkspaceId) {
    const trimmedWorkspaceIdentifier = workspaceIdentifier.trim();
    if (!trimmedWorkspaceIdentifier || normalizedIdentifiers.includes(trimmedWorkspaceIdentifier)) {
      continue;
    }
    normalizedIdentifiers.push(trimmedWorkspaceIdentifier);
  }

  return normalizedIdentifiers;
}

function sortWorkspacesByPreferredIdentifiers(
  workspaces: readonly StoredWorkspaceRecord[],
  preferredIdentifiers: readonly string[],
): StoredWorkspaceRecord[] {
  const preferredWorkspaceIds = normalizePreferredWorkspaceIdentifiers(preferredIdentifiers)
    .map((workspaceIdentifier) => workspaces.find((workspace) => (
      workspace.id === workspaceIdentifier || workspace.slug === workspaceIdentifier
    ))?.id)
    .filter((workspaceId): workspaceId is string => typeof workspaceId === "string");

  if (preferredWorkspaceIds.length === 0) {
    return [...workspaces];
  }

  const seen = new Set<string>();
  const orderedWorkspaces: StoredWorkspaceRecord[] = [];

  for (const workspaceId of preferredWorkspaceIds) {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace && !seen.has(workspace.id)) {
      seen.add(workspace.id);
      orderedWorkspaces.push(workspace);
    }
  }

  for (const workspace of workspaces) {
    if (!seen.has(workspace.id)) {
      seen.add(workspace.id);
      orderedWorkspaces.push(workspace);
    }
  }

  return orderedWorkspaces;
}

function ensureWorkspaceMembershipsSync(currentUser: AuthUser): StoredWorkspaceMembershipRecord[] {
  if (currentUser.isPlatformAdmin) {
    return listActiveSsoWorkspacesSync()
      .map((workspace) => ({
        id: `platform-admin-scope-${workspace.id}-${currentUser.id}`,
        workspaceId: workspace.id,
        userId: currentUser.id,
        role: "admin",
        status: "active",
        joinedAt: new Date(0).toISOString(),
      }));
  }
  const memberships = listUserWorkspacesSync(currentUser.id)
    .filter((membership) => membership.workspaceId.startsWith("sso-"));
  return memberships;
}
