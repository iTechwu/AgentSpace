import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  createAuthIdentitySync,
  createChannelParticipantSync,
  createSessionSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  removeWorkspaceMembershipSync,
} from "../../../packages/db/src/index.ts";
import { createDefaultWorkspaceState } from "../../../packages/domain/src/workspace.ts";
import { writeWorkspaceStateSync } from "../../../packages/services/src/index.ts";

const AUTH_COOKIE_NAME = "dofe_agent_session";
const WORKSPACE_SELECTION_COOKIE = "dofe_agent_workspace";
const WORKSPACE_RECENT_SELECTION_COOKIE = "dofe_agent_recent_workspaces";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface SeededWorkspaceSession {
  agentName: string;
  channelName: string;
  privateChannelName: string;
  userDisplayName: string;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
}

export async function ensureWorkspaceSession(page: Page): Promise<SeededWorkspaceSession> {
  return openSeededWorkspacePage(page, "/im");
}

async function dismissWorkspaceChromeOverlays(page: Page): Promise<void> {
  const closeOnboarding = page.getByRole("button", { name: /关闭新手引导|Close onboarding/i });
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click();
  }
}

export async function seedWorkspaceSession(page: Page): Promise<SeededWorkspaceSession> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const userDisplayName = `E2E Owner ${suffix}`;
  const agentName = `Atlas ${suffix}`;
  const channelName = `e2e-general-${suffix}`;
  const privateChannelName = `e2e-private-${suffix}`;
  const workspaceId = `sso-team-e2e-${suffix}`;
  const user = createUserSync({
    displayName: userDisplayName,
    primaryEmail: `e2e-owner-${suffix}@example.com`,
  });
  createAuthIdentitySync({
    userId: user.id,
    provider: "sso",
    providerSubject: `e2e-subject-${suffix}`,
    email: user.primaryEmail,
    emailVerified: true,
    profileJson: JSON.stringify({ issuer: "e2e.sso.dofe.test" }),
  });
  const workspace = createWorkspaceSync({
    id: workspaceId,
    createdBy: user.id,
    name: `E2E Workspace ${suffix}`,
    slug: workspaceId,
  });
  createWorkspaceMembershipSync({
    role: "owner",
    userId: user.id,
    workspaceId: workspace.id,
  });

  const state = createDefaultWorkspaceState();
  state.organizationName = workspace.name;
  state.humanMembers = [{ name: user.displayName, role: "Owner" }];
  state.activeEmployees = [
    {
      name: agentName,
      role: "Agent",
      remarkName: agentName,
      channelMemberAccess: "enabled",
      origin: "e2e-seed",
      summary: `${agentName} is available for workspace navigation smoke tests.`,
      traits: [],
      fit: "Ready for E2E navigation coverage.",
      skillIds: [],
      channels: [channelName],
      status: "active",
      instructions: "",
    },
  ];
  state.channels = [
    {
      name: channelName,
      kind: "group",
      humanMemberNames: [user.displayName],
      humanMembers: 1,
      employeeNames: [agentName],
    },
    {
      name: privateChannelName,
      kind: "group",
      humanMemberNames: [user.displayName],
      humanMembers: 1,
      employeeNames: [agentName],
    },
  ];
  state.messages = [
    {
      id: `message-${suffix}`,
      channel: channelName,
      speaker: user.displayName,
      speakerUserId: user.id,
      role: "human",
      time: new Date().toISOString(),
      summary: "Seeded conversation for workspace navigation smoke.",
      status: "completed",
      kind: "message",
    },
    {
      id: `private-message-${suffix}`,
      channel: privateChannelName,
      speaker: user.displayName,
      speakerUserId: user.id,
      role: "human",
      time: new Date().toISOString(),
      summary: "Private seeded conversation for access boundary coverage.",
      status: "completed",
      kind: "message",
    },
  ];
  state.tasks = [
    {
      id: `task-${suffix}`,
      title: "E2E workspace navigation task",
      channel: channelName,
      assignee: agentName,
      priority: "medium",
      status: "todo",
    },
  ];
  writeWorkspaceStateSync(state, workspace.id, { skipVersionCheck: true });

  const token = `sess-${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  createSessionSync({
    userId: user.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: expiresAt.toISOString(),
  });

  const cookieScope = resolveCookieScope();
  const expires = Math.floor(expiresAt.getTime() / 1000);
  await page.context().addCookies([
    {
      name: AUTH_COOKIE_NAME,
      value: token,
      ...cookieScope,
      httpOnly: true,
      sameSite: "Lax",
      expires,
    },
    {
      name: WORKSPACE_SELECTION_COOKIE,
      value: workspace.slug,
      ...cookieScope,
      httpOnly: true,
      sameSite: "Lax",
      expires,
    },
    {
      name: WORKSPACE_RECENT_SELECTION_COOKIE,
      value: workspace.slug,
      ...cookieScope,
      httpOnly: true,
      sameSite: "Lax",
      expires,
    },
  ]);

  return {
    agentName,
    channelName,
    privateChannelName,
    userDisplayName: user.displayName,
    userId: user.id,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
  };
}

export async function seedChannelScopedGuestSession(page: Page): Promise<SeededWorkspaceSession> {
  const session = await seedWorkspaceSession(page);
  removeWorkspaceMembershipSync(session.workspaceId, session.userId);
  createChannelParticipantSync({
    workspaceId: session.workspaceId,
    channelName: session.channelName,
    userId: session.userId,
    addedBy: session.userId,
  });
  return session;
}

export async function openSeededWorkspacePage(
  page: Page,
  path: string,
): Promise<SeededWorkspaceSession> {
  const session = await seedWorkspaceSession(page);
  await page.goto(`/w/${session.workspaceSlug}${path.startsWith("/") ? path : `/${path}`}`);
  await expect(page.locator(".workspace-layout")).toBeVisible();
  await dismissWorkspaceChromeOverlays(page);
  return session;
}

function resolveCookieUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL?.trim()
    || `http://127.0.0.1:${process.env.PORT ?? 3000}/`;
}

function resolveCookieScope(): { domain: string; path: string; secure: boolean } {
  const url = new URL(resolveCookieUrl());
  return {
    domain: url.hostname,
    path: "/",
    secure: url.protocol === "https:",
  };
}
