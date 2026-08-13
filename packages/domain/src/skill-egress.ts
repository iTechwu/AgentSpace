/**
 * Shared strict parser for skill egress allowlist origins.
 *
 * One parser serves every phase so the object an admin approves is exactly
 * the object the runtime enforces:
 *   - manifest validation (services/skills/package/manifest-schema.ts)
 *   - approval risk summary (services/skills/install-approval.ts)
 *   - task snapshot grant freezing (services/skills/installations.ts)
 *   - Runner / managed-service DNS pinning (daemon skill-runner.ts,
 *     skill-service/managed-service-runtime.ts)
 *   - service catalog admission (services/skill-services/catalog.ts)
 *
 * Rules: only http/https origins or bare hostnames; no credentials, path,
 * query, fragment or wildcards; no raw IPv4/IPv6 literals; no localhost,
 * private-suffix or single-label names (they may resolve to private
 * addresses). Explicit non-default ports are only accepted where a L3/L4
 * firewall enforces them (`allowExplicitPort`) — the DNS-pin layer alone
 * cannot restrict ports, so there they are rejected fail-closed.
 */

export interface SkillEgressOrigin {
  /** Normalized lowercase hostname (punycode for IDN), no trailing dot. */
  hostname: string;
  /** Explicit non-default port, present only when `allowExplicitPort` accepted it. */
  port?: number;
}

export type SkillEgressOriginParse =
  | { ok: true; origin: SkillEgressOrigin }
  | { ok: false; reason: string };

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names under these suffixes resolve via mDNS / private naming, not public DNS. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".corp"];

export function parseSkillEgressOrigin(
  entry: string,
  options?: { allowExplicitPort?: boolean },
): SkillEgressOriginParse {
  const trimmed = entry.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return { ok: false, reason: "expected a non-empty origin without whitespace" };
  }
  if (trimmed.includes("*")) {
    return { ok: false, reason: "wildcards cannot be pinned; list each hostname explicitly" };
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "expected a hostname or an HTTP(S) origin" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https schemes are supported" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials are forbidden" };
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, reason: "only an origin is allowed; path, query and fragment cannot be enforced" };
  }
  // WHATWG URL normalizes integer/hex/partial IPv4 and lowercases the host, so
  // checks below run on the canonical form. Default ports (80/443) are dropped
  // by the parser and simply normalize away.
  const hostname = url.hostname.replace(/\.$/, "");
  if (!hostname) {
    return { ok: false, reason: "host is required" };
  }
  let port: number | undefined;
  if (url.port) {
    const parsed = Number(url.port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      return { ok: false, reason: "port must be between 1 and 65535" };
    }
    if (!options?.allowExplicitPort) {
      return { ok: false, reason: "non-default ports require L3/L4 enforcement; declare the hostname only" };
    }
    port = parsed;
  }
  if (hostname.startsWith("[") || hostname.includes(":")) {
    return { ok: false, reason: "raw IPv6 addresses are forbidden; declare a hostname" };
  }
  if (IPV4_PATTERN.test(hostname)) {
    return { ok: false, reason: "raw IPv4 addresses are forbidden; declare a hostname" };
  }
  if (hostname === "localhost" || PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, reason: "localhost and private-suffix names are forbidden" };
  }
  if (!hostname.includes(".")) {
    return { ok: false, reason: "single-label names may resolve to private addresses; declare a fully qualified hostname" };
  }
  if (hostname.length > 253) {
    return { ok: false, reason: "hostname is too long (max 253 characters)" };
  }
  if (hostname.split(".").some((label) => !HOSTNAME_LABEL_PATTERN.test(label))) {
    return { ok: false, reason: "invalid hostname syntax" };
  }
  return { ok: true, origin: port === undefined ? { hostname } : { hostname, port } };
}

/** Canonical display/approval-key form: `hostname` or `hostname:port`. */
export function formatSkillEgressOrigin(origin: SkillEgressOrigin): string {
  return origin.port === undefined ? origin.hostname : `${origin.hostname}:${origin.port}`;
}

export interface SkillEgressAllowlistNormalization {
  /** Deduped, locale-sorted canonical origins (approval keys, frozen grants). */
  formatted: string[];
  /** Deduped hostnames in the same order (DNS pinning). */
  hostnames: string[];
  invalid: Array<{ entry: string; reason: string }>;
}

/**
 * Normalizes a raw allowlist through the strict parser. Callers either reject
 * on `invalid` (validation/admission) or fail closed when it is non-empty
 * (runtime), so a malformed entry never silently becomes a different host.
 */
export function normalizeSkillEgressAllowlist(
  entries: readonly string[],
  options?: { allowExplicitPort?: boolean },
): SkillEgressAllowlistNormalization {
  const formatted = new Set<string>();
  const hostnames = new Set<string>();
  const invalid: Array<{ entry: string; reason: string }> = [];
  for (const entry of entries) {
    const parsed = parseSkillEgressOrigin(entry, options);
    if (!parsed.ok) {
      invalid.push({ entry, reason: parsed.reason });
      continue;
    }
    formatted.add(formatSkillEgressOrigin(parsed.origin));
    hostnames.add(parsed.origin.hostname);
  }
  const sortEn = (a: string, b: string) => a.localeCompare(b, "en-US");
  return {
    formatted: Array.from(formatted).sort(sortEn),
    hostnames: Array.from(hostnames).sort(sortEn),
    invalid,
  };
}
