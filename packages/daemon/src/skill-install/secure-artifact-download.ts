import { promises as dnsPromises } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
export const MAX_SKILL_ARTIFACT_FILE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export interface SkillArtifactResolvedAddress {
  family: "ipv4" | "ipv6";
  address: string;
}

export interface SkillArtifactDownloadResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(error?: Error): void;
}

export type SkillArtifactHostLookup = (hostname: string) => Promise<SkillArtifactResolvedAddress[]>;
export type SkillArtifactHttpsRequest = (
  url: URL,
  pinnedAddresses: SkillArtifactResolvedAddress[],
  signal: AbortSignal,
) => Promise<SkillArtifactDownloadResponse>;

export type SkillArtifactPinnedLookup = (
  hostname: string,
  options: number | { all?: boolean },
  callback: (...args: unknown[]) => void,
) => void;

export class SkillArtifactDownloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SkillArtifactDownloadError";
    this.code = code;
  }
}

export interface SkillArtifactDownloadInput {
  url: string;
  expectedSize: number;
  timeoutMs?: number;
  lookupHost?: SkillArtifactHostLookup;
  request?: SkillArtifactHttpsRequest;
  allowedOrigins?: string[];
  allowedPrivateOrigins?: string[];
}

export async function downloadSkillArtifactFile(input: SkillArtifactDownloadInput): Promise<Uint8Array> {
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0
    || input.expectedSize > MAX_SKILL_ARTIFACT_FILE_DOWNLOAD_BYTES) {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_size_invalid",
      `Expected size must be between 0 and ${MAX_SKILL_ARTIFACT_FILE_DOWNLOAD_BYTES} bytes.`,
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await downloadRedirectHop({
      url: parseUrl(input.url),
      expectedSize: input.expectedSize,
      redirectsRemaining: MAX_REDIRECTS,
      lookupHost: input.lookupHost ?? defaultLookupHost,
      request: input.request ?? defaultHttpsRequest,
      allowedOrigins: normalizeOrigins(input.allowedOrigins ?? readOriginsEnv("DOFE_AGENT_SKILL_ARTIFACT_DOWNLOAD_ORIGINS")),
      allowedPrivateOrigins: normalizeOrigins(
        input.allowedPrivateOrigins ?? readOriginsEnv("DOFE_AGENT_SKILL_ARTIFACT_PRIVATE_DOWNLOAD_ORIGINS"),
      ),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof SkillArtifactDownloadError)) {
      throw new SkillArtifactDownloadError("skill_installation.download_timeout", "Artifact download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadRedirectHop(input: {
  url: URL;
  expectedSize: number;
  redirectsRemaining: number;
  lookupHost: SkillArtifactHostLookup;
  request: SkillArtifactHttpsRequest;
  allowedOrigins: Set<string>;
  allowedPrivateOrigins: Set<string>;
  signal: AbortSignal;
}): Promise<Uint8Array> {
  validateDownloadUrl(input.url, input.allowedOrigins);
  const addresses = await resolvePinnedAddresses(input.url, input.lookupHost, input.allowedPrivateOrigins);
  const response = await input.request(input.url, addresses, input.signal);
  if (isRedirect(response.statusCode)) {
    const location = singleHeader(response.headers.location);
    response.destroy();
    if (!location) {
      throw new SkillArtifactDownloadError("skill_installation.download_redirect_invalid", "Redirect has no Location header.");
    }
    if (input.redirectsRemaining === 0) {
      throw new SkillArtifactDownloadError("skill_installation.download_redirect_limit", "Artifact download exceeded redirect limit.");
    }
    return downloadRedirectHop({
      ...input,
      url: parseUrl(new URL(location, input.url).href),
      redirectsRemaining: input.redirectsRemaining - 1,
    });
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new SkillArtifactDownloadError(
      "skill_installation.download_http_error",
      `Artifact download returned HTTP ${response.statusCode}.`,
    );
  }

  const contentLength = Number(singleHeader(response.headers["content-length"]));
  if (Number.isFinite(contentLength) && contentLength > input.expectedSize) {
    response.destroy();
    throw new SkillArtifactDownloadError(
      "skill_installation.download_size_exceeded",
      `Response Content-Length ${contentLength} exceeds declared size ${input.expectedSize}.`,
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > input.expectedSize || total > MAX_SKILL_ARTIFACT_FILE_DOWNLOAD_BYTES) {
        response.destroy();
        throw new SkillArtifactDownloadError(
          "skill_installation.download_size_exceeded",
          `Artifact stream exceeded declared size ${input.expectedSize}.`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateDownloadUrl(url: URL, allowedOrigins: Set<string>): void {
  if (url.protocol !== "https:") {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_https_required",
      `Artifact download requires HTTPS, got ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_credentials_forbidden",
      "Artifact download URL must not contain userinfo credentials.",
    );
  }
  if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_origin_forbidden",
      `Artifact origin ${url.origin} is not in the managed-node allow-list.`,
    );
  }
}

async function resolvePinnedAddresses(
  url: URL,
  lookupHost: SkillArtifactHostLookup,
  allowedPrivateOrigins: Set<string>,
): Promise<SkillArtifactResolvedAddress[]> {
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ family: literalFamily === 4 ? "ipv4" as const : "ipv6" as const, address: hostname }]
    : await lookupHost(hostname);
  const unique = [...new Map(addresses.map((address) => [`${address.family}:${address.address}`, address])).values()];
  if (unique.length === 0) {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_dns_failed",
      `Artifact host ${hostname} did not resolve.`,
    );
  }
  if (!allowedPrivateOrigins.has(url.origin) && unique.some((address) => isPrivateOrSpecialAddress(address.address))) {
    throw new SkillArtifactDownloadError(
      "skill_installation.download_private_address_forbidden",
      `Artifact host ${hostname} resolves to a private or special-purpose address.`,
    );
  }
  return unique;
}

export function isPrivateOrSpecialAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a! >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrSpecialAddress(normalized.slice("::ffff:".length));
    }
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00;
  }
  return true;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new SkillArtifactDownloadError("skill_installation.download_url_invalid", "Artifact download URL is invalid.");
  }
}

function normalizeOrigins(values: string[]): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const parsed = parseUrl(value.trim());
    if (parsed.protocol !== "https:" || parsed.origin !== value.trim().replace(/\/$/, "")) {
      throw new SkillArtifactDownloadError(
        "skill_installation.download_origin_config_invalid",
        `Configured artifact download origin must be an HTTPS origin: ${value}`,
      );
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function readOriginsEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function defaultLookupHost(hostname: string): Promise<SkillArtifactResolvedAddress[]> {
  try {
    const addresses = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      family: family === 6 ? "ipv6" : "ipv4",
      address,
    }));
  } catch {
    return [];
  }
}

export function createPinnedAddressLookup(
  pinnedAddresses: SkillArtifactResolvedAddress[],
): SkillArtifactPinnedLookup {
  return (_hostname, options, callback) => {
    const addresses = pinnedAddresses.map((entry) => ({
      address: entry.address,
      family: entry.family === "ipv6" ? 6 : 4,
    }));
    if (typeof options === "object" && options.all) {
      callback(null, addresses);
      return;
    }
    const selected = addresses[0]!;
    callback(null, selected.address, selected.family);
  };
}

const defaultHttpsRequest: SkillArtifactHttpsRequest = (url, pinnedAddresses, signal) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      signal,
      lookup: createPinnedAddressLookup(pinnedAddresses) as never,
    }, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        destroy: (error?: Error) => response.destroy(error),
      });
    });
    request.on("error", reject);
    request.end();
  });
