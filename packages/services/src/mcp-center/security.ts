import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Ajv } from "ajv";
import type { McpErrorCode } from "@dofe-agent/db";

const MCP_SECRET_VERSION = "mcp1";
const MAX_SECRET_LENGTH = 4096;
/** Grant envelopes carry a whole resolved bundle (many connections/tools), so
 *  they get their own version tag and a much larger explicit size limit — they
 *  must NOT be constrained by the single-secret 4096-char cap. */
const MCP_GRANT_VERSION = "mcpg1";
const MAX_GRANT_LENGTH = 512 * 1024;

/* ------------------------------------------------------------------ */
/* Envelope encryption (AES-256-GCM, control-plane only)               */
/* Format: "<version>:<iv base64url>:<authTag base64url>:<ciphertext base64url>" */
/* The db layer stores this opaque string unchanged.                    */
/* ------------------------------------------------------------------ */

function readMcpEncryptionKey(): Buffer {
  const value =
    process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY?.trim() ||
    process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY?.trim() ||
    process.env.DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY is required to store MCP connection secrets.");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function encryptEnvelope(plaintext: string, version: string, maxLength: number, label: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
  const key = readMcpEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  return [version, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decryptEnvelope(value: string, version: string, label: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== version) {
    throw new Error(`Unsupported ${label} encryption version.`);
  }
  const [, ivBase64, authTagBase64, ciphertextBase64] = parts;
  if (!ivBase64 || !authTagBase64 || !ciphertextBase64) {
    throw new Error(`Invalid ${label} encryption format.`);
  }
  const key = readMcpEncryptionKey();
  const iv = Buffer.from(ivBase64, "base64url");
  const authTag = Buffer.from(authTagBase64, "base64url");
  const ciphertext = Buffer.from(ciphertextBase64, "base64url");
  if (iv.length !== 12) {
    throw new Error(`Invalid ${label} initialization vector.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(`Failed to decrypt ${label}.`);
  }
}

export function encryptMcpSecret(plaintext: string): string {
  return encryptEnvelope(plaintext, MCP_SECRET_VERSION, MAX_SECRET_LENGTH, "MCP secret value");
}

export function decryptMcpSecret(value: string): string {
  return decryptEnvelope(value, MCP_SECRET_VERSION, "MCP secret");
}

export function encryptMcpGrant(plaintext: string): string {
  return encryptEnvelope(plaintext, MCP_GRANT_VERSION, MAX_GRANT_LENGTH, "MCP grant");
}

export function decryptMcpGrant(value: string): string {
  return decryptEnvelope(value, MCP_GRANT_VERSION, "MCP grant");
}

export const MCP_SECRET_KEY_VERSION = MCP_SECRET_VERSION;

/* ------------------------------------------------------------------ */
/* Endpoint validation (SSRF + host allow-list)                        */
/* ------------------------------------------------------------------ */

export interface McpEndpointValidation {
  ok: boolean;
  code?: McpErrorCode;
  message?: string;
  host?: string;
}

/**
 * Validates an MCP endpoint URL. The daemon re-checks the resolved IP at call time;
 * this is the control-plane gate that rejects obviously unsafe targets before a
 * connection is even created.
 */
export function validateMcpEndpoint(endpoint: string, allowedHosts: string[]): McpEndpointValidation {
  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    return { ok: false, code: "mcp.policy_denied", message: "Endpoint is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint must use HTTPS." };
  }
  if (parsed.port && parsed.port !== "443") {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint must use the standard HTTPS port." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint is missing a host." };
  }
  if (isForbiddenMcpNetworkAddress(host)) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint host is not allowed (loopback, link-local, private, or metadata address)." };
  }
  if (!isHostAllowed(host, allowedHosts)) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint host is not in the catalog allow-list." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint must not carry credentials in the URL." };
  }
  if (parsed.search || parsed.hash) {
    // Connection endpoints are persisted and their management summary reaches
    // the browser. Query and fragment data are not a safe credential channel.
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint must not contain query or fragment data." };
  }
  return { ok: true, host };
}

/** True for IP literals and DNS answers that must never be reachable from MCP. */
export function isForbiddenMcpNetworkAddress(host: string): boolean {
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    return true;
  }
  // Strip IPv6 brackets.
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "0.0.0.0" || bare === "::") {
    return true;
  }
  // Metadata / link-local / loopback / private IPv4 ranges.
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  // IPv4-mapped IPv6 addresses must receive the same private-range treatment.
  const mappedV4 = bare.toLowerCase().match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedV4 && isForbiddenMcpNetworkAddress(mappedV4[1])) {
    return true;
  }
  // IPv6 link-local / loopback.
  if (bare.toLowerCase().startsWith("fe80:") || bare.toLowerCase().startsWith("fc") || bare.toLowerCase().startsWith("fd")) {
    return true;
  }
  return false;
}

/** A hostname is usable only when DNS returned at least one address and every answer is public. */
export function validateMcpResolvedAddresses(addresses: string[]): McpEndpointValidation {
  if (addresses.length === 0) {
    return { ok: false, code: "mcp.network_unreachable", message: "MCP endpoint did not resolve to an address." };
  }
  if (addresses.some(isForbiddenMcpNetworkAddress)) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP endpoint resolved to a forbidden network address." };
  }
  return { ok: true };
}

export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase();
  for (const entry of allowedHosts) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === normalized) return true;
    // Suffix rule: ".example.com" matches "api.example.com" but not "evilexample.com".
    if (rule.startsWith(".") && normalized.endsWith(rule)) return true;
    if (rule.startsWith("*.")) {
      const base = rule.slice(1); // ".example.com"
      if (normalized.endsWith(base)) return true;
    }
  }
  return false;
}

/** Only explicitly configured, scalar HTTP headers may accompany an MCP request. */
export function validateMcpRequestHeaders(value: Record<string, unknown>): McpEndpointValidation {
  const entries = Object.entries(value);
  if (entries.length > 32) {
    return { ok: false, code: "mcp.policy_denied", message: "Too many MCP request headers." };
  }
  for (const [name, rawValue] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) {
      return { ok: false, code: "mcp.policy_denied", message: "MCP request header name is invalid." };
    }
    if (["connection", "content-length", "host", "transfer-encoding"].includes(name.toLowerCase())) {
      return { ok: false, code: "mcp.policy_denied", message: "MCP request header is reserved." };
    }
    if (typeof rawValue !== "string" || rawValue.length > 4096 || /[\r\n]/.test(rawValue)) {
      return { ok: false, code: "mcp.policy_denied", message: "MCP request header value is invalid." };
    }
  }
  return { ok: true };
}

/** Validates the non-secret header configuration against the reviewed catalog schema. */
export function validateMcpConnectionConfiguration(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): McpEndpointValidation {
  if (schema.type !== "object" || schema.additionalProperties !== false || schema.patternProperties !== undefined) {
    return { ok: false, code: "mcp.policy_denied", message: "MCP catalog configuration schema is not safely constrained." };
  }
  try {
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    if (!validate(value)) {
      return { ok: false, code: "mcp.policy_denied", message: "MCP connection configuration does not match the catalog schema." };
    }
  } catch {
    return { ok: false, code: "mcp.policy_denied", message: "MCP catalog configuration schema is invalid." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

export function redactMcpText(input: string, maxLen = 4000): string {
  let value = input;
  // Strip "Bearer <token>" first so the Authorization-header value does not shield the token.
  value = value.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "[REDACTED]");
  value = value.replace(
    /(api[_-]?key|api[_-]?secret|access[_-]?key|client[_-]?secret|token|secret|password|authorization|cookie)["'\s:=]*[A-Za-z0-9._\-]+/gi,
    "$1=[REDACTED]",
  );
  if (value.length > maxLen) {
    value = value.slice(-maxLen);
  }
  return value;
}

const SENSITIVE_SCHEMA_FIELD = /api[_-]?(?:key|secret)|access[_-]?key|client[_-]?secret|token|secret|password|authorization|cookie/i;
const SCHEMA_SAMPLE_KEY = new Set(["default", "example", "examples", "const", "enum"]);

/** Redacts secret-like defaults and examples that may appear in a remote tool's input schema. */
export function redactToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  try {
    return redactSchemaValue(schema) as Record<string, unknown>;
  } catch {
    // A schema that cannot be safely traversed cannot cross the Provider boundary.
    return {};
  }
}

function redactSchemaValue(value: unknown, sensitiveContext = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSchemaValue(entry, sensitiveContext));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveContext && SCHEMA_SAMPLE_KEY.has(key)) {
      continue;
    }
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([propertyName, definition]) => [
          propertyName,
          redactSchemaValue(definition, sensitiveContext || SENSITIVE_SCHEMA_FIELD.test(propertyName)),
        ]),
      );
      continue;
    }
    output[key] = redactSchemaValue(child, sensitiveContext || SENSITIVE_SCHEMA_FIELD.test(key));
  }
  return output;
}
