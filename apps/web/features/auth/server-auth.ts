import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import type { NextResponse } from "next/server";
import {
  createAuthIdentitySync,
  createSessionSync,
  createUserSync,
  deleteSessionByTokenHashSync,
  listUserWorkspacesSync,
  readAuthIdentityByProviderSubjectSync,
  readSessionByTokenHashSync,
  readUserByEmailSync,
  readUserSync,
  readWorkspaceSync,
  touchSessionLastSeenSync,
  updateUserSync,
  type StoredSessionRecord,
  type StoredUserRecord,
} from "@dofe-agent/db";
import { tryRecordPlatformAuditEventSync, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { syncSsoWorkspacesForUserSync, type SsoWorkspaceScope } from "./sso-workspaces";
import { clearWorkspaceSelectionCookie, writeWorkspaceSelectionCookie } from "./workspace-selection";

const AUTH_COOKIE_NAME = "dofe_agent_session";
const SSO_ID_TOKEN_COOKIE_NAME = "dofe_agent_sso_id_token";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface SsoLoginSession {
  idToken: string;
  sessionToken: string;
}

export interface AuthUser {
  id: string;
  organizationName: string;
  displayName: string;
  role: string;
  email: string;
  isPlatformAdmin: boolean;
}

export const getCurrentUser = cache(async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await getCurrentSession();
  const user = session ? readUserSync(session.userId) : null;
  return user ? toPublicUser(user) : null;
});

export const getCurrentSession = cache(async function getCurrentSession(): Promise<StoredSessionRecord | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  return token ? readSessionBySessionToken(token) : null;
});

export async function createSessionForSsoLogin(input: {
  avatarUrl?: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
  isAdmin?: boolean;
  subject: string;
  workspaceScopes: SsoWorkspaceScope[];
}): Promise<{ isNewUser: boolean; session: SsoLoginSession; user: AuthUser }> {
  if (input.workspaceScopes.length === 0) {
    throw new Error("auth.sso_no_workspace");
  }
  const existingIdentity = readAuthIdentityByProviderSubjectSync("sso", input.subject);
  let user = existingIdentity ? readUserSync(existingIdentity.userId) : null;
  let isNewUser = false;

  if (!user) {
    // Only a verified SSO email can bridge an existing local account.
    user = input.emailVerified ? readUserByEmailSync(input.email) : null;
    if (!user) {
      user = createUserSync({
        displayName: input.displayName,
        primaryEmail: input.email,
        avatarUrl: input.avatarUrl,
        isAdmin: input.isAdmin,
      });
      isNewUser = true;
    }
    createAuthIdentitySync({
      userId: user.id,
      provider: "sso",
      providerSubject: input.subject,
      email: input.email,
      emailVerified: input.emailVerified,
      profileJson: JSON.stringify({ issuer: "sso.ixicai.cn" }),
    });
  }

  const updatedUser = updateUserSync({
    userId: user.id,
    displayName: input.displayName,
    primaryEmail: input.email,
    avatarUrl: input.avatarUrl,
    isAdmin: input.isAdmin,
  }) ?? user;
  const ssoWorkspaces = syncSsoWorkspacesForUserSync({
    displayName: updatedUser.displayName,
    materializeMemberships: updatedUser.isAdmin !== true,
    scopes: input.workspaceScopes,
    userId: updatedUser.id,
  });
  if (ssoWorkspaces[0]) {
    const workspace = readWorkspaceSync(ssoWorkspaces[0].id);
    if (workspace) await writeWorkspaceSelectionCookie(workspace.slug);
  }
  const session = await createSsoLoginSession(updatedUser.id, input.idToken);
  if (updatedUser.isAdmin) {
    tryRecordPlatformAuditEventSync({
      title: "Platform administrator login succeeded",
      note: `${updatedUser.displayName} signed in through Dofe SSO.`,
      code: "auth.sso_platform_admin_login_succeeded",
      data: { actorUserId: updatedUser.id },
    });
  } else {
    tryRecordUserWorkspaceAuditEventSync(updatedUser.id, {
      title: "Dofe SSO login succeeded",
      note: `${updatedUser.displayName} signed in through Dofe SSO.`,
      code: "auth.sso_login_succeeded",
    });
  }
  return { isNewUser, session, user: toPublicUser(updatedUser) };
}

export function writeSsoLoginSessionCookies(response: NextResponse, session: SsoLoginSession): void {
  const options = {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };
  response.cookies.set(AUTH_COOKIE_NAME, session.sessionToken, options);
  response.cookies.set(SSO_ID_TOKEN_COOKIE_NAME, session.idToken, options);
}

export async function readCurrentSsoIdToken(): Promise<string | undefined> {
  return (await cookies()).get(SSO_ID_TOKEN_COOKIE_NAME)?.value;
}

export async function clearCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (token) {
    const tokenHash = hashSessionToken(token);
    const session = readSessionByTokenHashSync(tokenHash);
    if (session) {
      tryRecordUserWorkspaceAuditEventSync(session.userId, {
        title: "Logout",
        note: "Session was signed out.",
        code: "auth.logout",
      });
    }
    deleteSessionByTokenHashSync(tokenHash);
  }
  await clearWorkspaceSelectionCookie();
  clearAuthCookie(cookieStore, AUTH_COOKIE_NAME);
  clearAuthCookie(cookieStore, SSO_ID_TOKEN_COOKIE_NAME);
}

function readSessionBySessionToken(token: string): StoredSessionRecord | null {
  const tokenHash = hashSessionToken(token);
  const session = readSessionByTokenHashSync(tokenHash);
  if (!session || session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    deleteSessionByTokenHashSync(tokenHash);
    return null;
  }
  touchSessionLastSeenSync(tokenHash);
  return readSessionByTokenHashSync(tokenHash);
}

async function createSsoLoginSession(userId: string, idToken: string): Promise<SsoLoginSession> {
  const token = `sess-${randomBytes(24).toString("hex")}`;
  const headerStore = await headers();
  createSessionSync({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
    ipAddress: extractIpAddress(headerStore.get("x-forwarded-for")),
    userAgent: headerStore.get("user-agent")?.trim() || undefined,
  });
  return { idToken, sessionToken: token };
}

function clearAuthCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, name: string): void {
  cookieStore.set(name, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

function toPublicUser(user: StoredUserRecord): AuthUser {
  const membership = listUserWorkspacesSync(user.id)[0];
  const workspace = membership ? readWorkspaceSync(membership.workspaceId) : null;
  return {
    id: user.id,
    organizationName: workspace?.name ?? "",
    displayName: user.displayName,
    role: membership?.role ?? "member",
    email: user.primaryEmail ?? "",
    isPlatformAdmin: user.isAdmin === true,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tryRecordUserWorkspaceAuditEventSync(userId: string, input: { title: string; note: string; code: string }): void {
  const membership = listUserWorkspacesSync(userId)[0];
  if (!membership) return;
  tryRecordWorkspaceAuditEventSync({
    workspaceId: membership.workspaceId,
    title: input.title,
    note: input.note,
    code: input.code,
    data: { actorType: "session_user", resourceType: "auth_session", userId },
  });
}

function extractIpAddress(forwardedFor: string | null): string | undefined {
  return forwardedFor?.split(",")[0]?.trim() || undefined;
}
