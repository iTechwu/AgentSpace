// 工作区 / 成员 / 用户 / 会话身份（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


// ─── New multi-tenant types ───────────────────────────────────────────────

/** A workspace — the primary isolation boundary */
export interface StoredWorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** Membership tying a user to a workspace with a role */
export type WorkspaceRole = "owner" | "admin" | "member";

export interface StoredWorkspaceMembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: "active" | "invited" | "removed";
  joinedAt: string;
  invitedBy?: string;
}

/** The new user table — replaces auth_user */
export interface StoredUserRecord {
  id: string;
  displayName: string;
  avatarUrl?: string;
  primaryEmail?: string;
  isAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/** A Dofe SSO identity linked to a local workspace user. */
export type AuthProvider = "sso";

export interface StoredAuthIdentityRecord {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email?: string;
  emailVerified: boolean;
  profileJson: string;
  createdAt: string;
  updatedAt: string;
}

/** Server-side session (replaces auth_session token model) */
export interface StoredSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
  ipAddress?: string;
  userAgent?: string;
  revokedAt?: string;
}
