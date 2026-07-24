import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createSsoInternalClient } from "@dofe/sso-node";
import { readServerEnvValue } from "./server-env";
import { buildSsoWorkspaceScopes, type SsoWorkspaceScope } from "./sso-workspaces";

const OIDC_STATE_TTL_SECONDS = 10 * 60;

export const SSO_OIDC_STATE_COOKIE = "agent_space_sso_oidc";

interface SsoConfig {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  internalApiUrl: string;
  internalApiSecret: string;
  issuer: string;
  jwksUri: string;
  redirectUri: string;
  serviceName: string;
}

interface SsoDiscovery {
  authorization_endpoint: string;
  end_session_endpoint?: string;
  issuer: string;
  jwks_uri: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface SsoOidcState {
  codeVerifier: string;
  invitationToken?: string;
  joinCode?: string;
  nonce: string;
  state: string;
}

export interface SsoProfile {
  avatarUrl?: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  subject: string;
  workspaceScopes: SsoWorkspaceScope[];
}

export async function createSsoAuthorizationRequest(input: {
  invitationToken?: string;
  joinCode?: string;
}): Promise<{ authorizationUrl: string; state: SsoOidcState }> {
  const [config, discovery] = await Promise.all([readSsoConfig(), readSsoDiscovery()]);
  assertDiscoveryMatchesConfig(config, discovery);

  const codeVerifier = randomUrlSafeValue(48);
  const state: SsoOidcState = {
    codeVerifier,
    invitationToken: normalizeContextValue(input.invitationToken, 256),
    joinCode: normalizeContextValue(input.joinCode, 64),
    nonce: randomUrlSafeValue(24),
    state: randomUrlSafeValue(24),
  };
  const params = new URLSearchParams({
    client_id: config.clientId,
    code_challenge: sha256Base64Url(codeVerifier),
    code_challenge_method: "S256",
    nonce: state.nonce,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state: state.state,
  });

  return {
    authorizationUrl: `${discovery.authorization_endpoint}?${params.toString()}`,
    state,
  };
}

export async function exchangeSsoAuthorizationCode(input: {
  code: string;
  expectedState: SsoOidcState;
  returnedState: string;
}): Promise<{ idToken: string; profile: SsoProfile }> {
  if (input.returnedState !== input.expectedState.state) {
    throw new Error("auth.sso_state_invalid");
  }

  const [config, discovery] = await Promise.all([readSsoConfig(), readSsoDiscovery()]);
  assertDiscoveryMatchesConfig(config, discovery);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      code: input.code,
      code_verifier: input.expectedState.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
    cache: "no-store",
  });
  const tokenBody = await readJsonResponse(tokenResponse, "auth.sso_token_exchange_failed");
  const accessToken = readRequiredString(tokenBody, "access_token", "auth.sso_token_exchange_failed");
  const idToken = readRequiredString(tokenBody, "id_token", "auth.sso_token_exchange_failed");
  const idTokenClaims = await verifyIdToken({ config, discovery, idToken, nonce: input.expectedState.nonce });

  const userInfoResponse = await fetch(discovery.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const userInfo = await readJsonResponse(userInfoResponse, "auth.sso_userinfo_failed");
  const subject = readRequiredString(userInfo, "sub", "auth.sso_userinfo_failed");
  if (idTokenClaims.sub !== subject) {
    throw new Error("auth.sso_subject_mismatch");
  }
  const internalClient = createSsoInternalClient({
    baseUrl: config.internalApiUrl,
    internalSecret: config.internalApiSecret,
    serviceName: config.serviceName,
  });
  const [authoritativeUser, tenants, teams, tenantPreference] = await Promise.all([
    internalClient.users.get(subject),
    internalClient.users.getTenants(subject),
    internalClient.users.getTeams(subject),
    internalClient.users.getTenantPreference(subject),
  ]).catch(() => {
    throw new Error("auth.sso_user_lookup_failed");
  });
  if (!authoritativeUser.isActive) {
    throw new Error("auth.sso_user_inactive");
  }

  return {
    idToken,
    profile: buildSsoProfile({
      authoritativeUser,
      subject,
      userInfo,
      workspaceScopes: buildSsoWorkspaceScopes({ teams, tenants, preferredTenantId: tenantPreference.lastTenantId }),
    }),
  };
}

export function buildSsoProfile(input: {
  authoritativeUser: {
    avatarUrl?: string | null;
    email?: string | null;
    nickname?: string | null;
  };
  subject: string;
  userInfo: Record<string, unknown>;
  workspaceScopes?: SsoWorkspaceScope[];
}): SsoProfile {
  const verifiedEmail = input.authoritativeUser.email?.trim().toLowerCase()
    || readOptionalString(input.userInfo, "email")?.toLowerCase();
  const emailVerified = input.userInfo.email_verified === true;
  if (verifiedEmail && !emailVerified) {
    throw new Error("auth.sso_email_not_verified");
  }
  const email = verifiedEmail ?? buildSsoPlaceholderEmail(input.subject);
  const displayName = input.authoritativeUser.nickname?.trim()
    || readOptionalString(input.userInfo, "name")
    || (verifiedEmail ? email.split("@", 1)[0] : undefined)
    || "Dofe user";

  return {
    avatarUrl: input.authoritativeUser.avatarUrl?.trim() || readOptionalString(input.userInfo, "picture"),
    displayName,
    email,
    emailVerified: Boolean(verifiedEmail),
    subject: input.subject,
    workspaceScopes: input.workspaceScopes ?? [],
  };
}

export function buildSsoCallbackRedirectUrl(path: string, requestUrl: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredRedirectUri = readServerEnvValue("SSO_REDIRECT_URI")?.trim();
  try {
    const baseUrl = new URL(configuredRedirectUri || requestUrl);
    return new URL(normalizedPath, `${baseUrl.origin}/`).toString();
  } catch {
    return new URL(normalizedPath, requestUrl).toString();
  }
}

export async function getSsoLogoutUrl(idToken: string): Promise<string> {
  const [config, discovery] = await Promise.all([readSsoConfig(), readSsoDiscovery()]);
  assertDiscoveryMatchesConfig(config, discovery);
  if (!discovery.end_session_endpoint) {
    return config.redirectUri.replace(/\/auth\/callback$/, "/");
  }

  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("id_token_hint", idToken);
  url.searchParams.set("post_logout_redirect_uri", config.redirectUri.replace(/\/auth\/callback$/, "/"));
  return url.toString();
}

export function encodeSsoOidcState(state: SsoOidcState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

export function decodeSsoOidcState(value: string | undefined): SsoOidcState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SsoOidcState>;
    if (
      typeof parsed.state !== "string"
      || typeof parsed.nonce !== "string"
      || typeof parsed.codeVerifier !== "string"
      || parsed.state.length < 16
      || parsed.nonce.length < 16
      || parsed.codeVerifier.length < 32
    ) {
      return null;
    }
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      invitationToken: normalizeContextValue(parsed.invitationToken, 256),
      joinCode: normalizeContextValue(parsed.joinCode, 64),
    };
  } catch {
    return null;
  }
}

export { OIDC_STATE_TTL_SECONDS };

async function readSsoConfig(): Promise<SsoConfig> {
  const config = {
    apiUrl: readRequiredEnv("SSO_API_URL"),
    clientId: readRequiredEnv("SSO_CLIENT_ID"),
    clientSecret: readRequiredEnv("SSO_CLIENT_SECRET"),
    discoveryUrl: readRequiredEnv("SSO_DISCOVERY_URL"),
    internalApiUrl: readRequiredEnv("SSO_INTERNAL_API_URL"),
    internalApiSecret: readRequiredEnv("INTERNAL_API_SECRET"),
    issuer: readRequiredEnv("SSO_ISSUER"),
    jwksUri: readRequiredEnv("JWKS_URI"),
    redirectUri: readRequiredEnv("SSO_REDIRECT_URI"),
    serviceName: readRequiredEnv("SSO_SERVICE_NAME"),
  };
  for (const [key, value] of Object.entries(config)) {
    if (key !== "clientId" && key !== "clientSecret" && key !== "internalApiSecret" && key !== "serviceName") {
      assertAbsoluteUrl(value, `SSO configuration ${key}`);
    }
  }
  return config;
}

async function readSsoDiscovery(): Promise<SsoDiscovery> {
  const config = await readSsoConfig();
  const response = await fetch(config.discoveryUrl, { cache: "no-store" }).catch(() => {
    throw new Error("auth.sso_discovery_failed");
  });
  const discovery = await readJsonResponse(response, "auth.sso_discovery_failed") as Partial<SsoDiscovery>;
  for (const field of ["authorization_endpoint", "issuer", "jwks_uri", "token_endpoint", "userinfo_endpoint"] as const) {
    if (typeof discovery[field] !== "string") throw new Error("auth.sso_discovery_failed");
  }
  return discovery as SsoDiscovery;
}

function assertDiscoveryMatchesConfig(config: SsoConfig, discovery: SsoDiscovery): void {
  if (discovery.issuer !== config.issuer || discovery.jwks_uri !== config.jwksUri) {
    throw new Error("auth.sso_discovery_mismatch");
  }
  if (!discovery.authorization_endpoint.startsWith(config.apiUrl) || !discovery.token_endpoint.startsWith(config.apiUrl)) {
    throw new Error("auth.sso_discovery_mismatch");
  }
}

async function verifyIdToken(input: {
  config: SsoConfig;
  discovery: SsoDiscovery;
  idToken: string;
  nonce: string;
}): Promise<Record<string, unknown>> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3) throw new Error("auth.sso_id_token_invalid");
  const header = parseJwtPart(parts[0]);
  const claims = parseJwtPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("auth.sso_id_token_invalid");
  const jwksResponse = await fetch(input.discovery.jwks_uri, { cache: "no-store" }).catch(() => {
    throw new Error("auth.sso_jwks_failed");
  });
  const jwks = await readJsonResponse(jwksResponse, "auth.sso_jwks_failed") as {
    keys?: Array<JsonWebKey & Record<string, unknown> & { kid?: string }>;
  };
  const key = jwks.keys?.find((candidate) => candidate.kid === header.kid);
  if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) {
    throw new Error("auth.sso_id_token_invalid");
  }
  const audience = claims.aud;
  const validAudience = audience === input.config.clientId || (Array.isArray(audience) && audience.includes(input.config.clientId));
  if (claims.iss !== input.config.issuer || !validAudience || claims.nonce !== input.nonce || typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("auth.sso_id_token_invalid");
  }
  return claims;
}

function parseJwtPart(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error("auth.sso_id_token_invalid");
  }
}

async function readJsonResponse(response: Response, errorCode: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(errorCode);
  const body = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(errorCode);
  return body as Record<string, unknown>;
}

function readRequiredString(body: Record<string, unknown>, field: string, errorCode: string): string {
  const value = readOptionalString(body, field);
  if (!value) throw new Error(errorCode);
  return value;
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredEnv(name: string): string {
  const value = readServerEnvValue(name);
  if (!value || value.startsWith("replace_with_")) throw new Error(`SSO configuration error: ${name} is required`);
  return value;
}

function assertAbsoluteUrl(value: string, label: string): void {
  try { new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
}

function randomUrlSafeValue(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function buildSsoPlaceholderEmail(subject: string): string {
  return `sso-${sha256Base64Url(subject).slice(0, 40).toLowerCase()}@users.dofe.invalid`;
}

function normalizeContextValue(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength ? value.trim() : undefined;
}
