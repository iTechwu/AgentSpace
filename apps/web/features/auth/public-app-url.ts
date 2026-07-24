import { readServerEnvValue } from "./server-env";

export function readPublicAppUrl(): string | undefined {
  const rawValue = readServerEnvValue("AGENT_SPACE_APP_URL")?.trim();
  if (!rawValue) {
    return undefined;
  }

  try {
    const url = new URL(rawValue);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function buildPublicAppUrl(path: string, appUrl?: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!appUrl) {
    return normalizedPath;
  }

  try {
    return new URL(normalizedPath, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
  } catch {
    return normalizedPath;
  }
}

export function buildSsoStartUrl(appUrl?: string, invitationToken?: string, joinCode?: string): string {
  const searchParams = new URLSearchParams();
  if (invitationToken?.trim()) {
    searchParams.set("invitationToken", invitationToken.trim());
  }
  if (joinCode?.trim()) {
    searchParams.set("joinCode", joinCode.trim());
  }

  const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  return buildPublicAppUrl(`/api/auth/sso/start${suffix}`, appUrl);
}
