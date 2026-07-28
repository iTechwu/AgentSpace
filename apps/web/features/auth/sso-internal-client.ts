import { createSsoInternalClient } from "@dofe/sso-node";
import { readServerEnvValue } from "./server-env";

export function readRequiredSsoEnv(name: string): string {
  const value = readServerEnvValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type SsoInternalClient = ReturnType<typeof createSsoInternalClient>;

/**
 * Build the service-to-service SSO internal client used to read/write the IdP
 * directory (sso.dofe.ai). Authenticated with the shared `INTERNAL_API_SECRET`.
 */
export function getSsoInternalClient(): SsoInternalClient {
  return createSsoInternalClient({
    baseUrl: readRequiredSsoEnv("SSO_INTERNAL_API_URL"),
    internalSecret: readRequiredSsoEnv("INTERNAL_API_SECRET"),
    serviceName: readRequiredSsoEnv("SSO_SERVICE_NAME"),
  });
}
