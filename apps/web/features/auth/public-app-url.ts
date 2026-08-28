import { readServerEnvValue } from "./server-env";

export function readPublicAppUrl(): string | undefined {
  const rawValue = readServerEnvValue("DOFE_AGENT_APP_URL")?.trim();
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

export function buildSsoStartUrl(appUrl?: string): string {
  return buildPublicAppUrl("/api/auth/sso/start", appUrl);
}
