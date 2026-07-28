import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TERMINAL_BILLING_STATUSES = new Set([
  "reconciled",
  "settled",
  "final",
  "billed",
  "charged",
  "completed",
]);

export function requiredEnv(env, names) {
  const values = {};
  const missing = [];
  const placeholders = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else if (isPlaceholderEnvValue(value)) {
      placeholders.push(name);
    } else {
      values[name] = value;
    }
  }
  if (missing.length > 0) throw new Error(`missing_required_environment:${missing.join(",")}`);
  if (placeholders.length > 0) {
    throw new Error(`placeholder_environment_refused:${placeholders.join(",")}`);
  }
  return values;
}

function isPlaceholderEnvValue(value) {
  const normalized = value.toLowerCase();
  if (/^(?:replace(?:_|-)with(?:_|-)|changeme$|xxx$)/.test(normalized)) return true;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "example.com" || hostname.endsWith(".example.com") || hostname.endsWith(".example");
  } catch {
    return false;
  }
}

export function splitList(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function validateManagedNetworkInspection(inspection, input) {
  if (!inspection || typeof inspection !== "object") throw new Error("network_inspection_invalid");
  if (inspection.Name !== input.network) throw new Error("network_name_mismatch");
  if (["bridge", "default", "host", "none"].includes(input.network.toLowerCase())) {
    throw new Error("permissive_network_refused");
  }
  const separator = input.policyLabel.indexOf("=");
  if (separator < 1) throw new Error("network_policy_label_invalid");
  const key = input.policyLabel.slice(0, separator);
  const expectedValue = input.policyLabel.slice(separator + 1);
  const actualValue = inspection.Labels?.[key];
  if (actualValue !== expectedValue) {
    throw new Error(`network_policy_label_mismatch:${key}`);
  }
  return {
    name: inspection.Name,
    driver: inspection.Driver,
    internal: Boolean(inspection.Internal),
    policyLabel: `${key}=${actualValue}`,
  };
}

export function validateBillingUsageLog(log, expected) {
  if (!log || typeof log !== "object") throw new Error("billing_log_invalid");
  for (const field of [
    "runtimeCredentialId",
    "runtimeId",
    "employeeId",
    "conversationId",
    "requestId",
    "model",
  ]) {
    if (log[field] !== expected[field]) throw new Error(`billing_attribution_mismatch:${field}`);
  }
  const billingStatus = String(log.billingStatus ?? "").trim().toLowerCase();
  if (!TERMINAL_BILLING_STATUSES.has(billingStatus)) throw new Error("billing_not_terminal");
  const totalCost = typeof log.totalCost === "number" ? log.totalCost : Number.parseFloat(log.totalCost);
  if (!Number.isFinite(totalCost) || totalCost < 0) throw new Error("billing_cost_invalid");
  const currency = String(log.currency ?? "").trim().toUpperCase();
  if (!currency) throw new Error("billing_currency_missing");
  const usageId = String(log.id ?? "").trim();
  if (!usageId) throw new Error("gateway_usage_id_missing");
  const inputTokens = readNonNegativeNumber(log.inputTokens, "input_tokens_invalid");
  const outputTokens = readNonNegativeNumber(log.outputTokens, "output_tokens_invalid");
  const cacheTokens = readCacheTokens(log);
  if (inputTokens + outputTokens <= 0) throw new Error("billing_tokens_missing");
  return {
    usageId,
    ...expected,
    billingStatus,
    totalCost,
    currency,
    inputTokens,
    outputTokens,
    cacheTokens,
    timestamp: String(log.timestamp ?? ""),
  };
}

export function evaluateEgressProbeEvidence(probes) {
  return probes.gateway?.reachable === true
    && probes.blockedUrls.every((probe) => !probe.reachable && !probe.tcpReachable)
    && probes.blockedIps.every((probe) => !probe.reachable)
    && probes.blockedProxies.every((probe) => !probe.reachable)
    && probes.proxyEnvironment.length === 0;
}

function readNonNegativeNumber(value, errorCode) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(errorCode);
  return number;
}

function readCacheTokens(log) {
  if (log.cacheTokens != null) return readNonNegativeNumber(log.cacheTokens, "cache_tokens_invalid");
  if (log.cachedTokens != null) return readNonNegativeNumber(log.cachedTokens, "cache_tokens_invalid");
  if (log.cacheReadTokens == null && log.cacheWriteTokens == null) throw new Error("cache_tokens_invalid");
  const cacheRead = readNonNegativeNumber(log.cacheReadTokens ?? 0, "cache_tokens_invalid");
  const cacheWrite = readNonNegativeNumber(log.cacheWriteTokens ?? 0, "cache_tokens_invalid");
  return cacheRead + cacheWrite;
}

export function persistReleaseEvidence(kind, evidence, env = process.env) {
  const createdAt = new Date().toISOString();
  const payload = { kind, createdAt, ...evidence };
  const baseDir = env.MANAGED_RUNTIME_EVIDENCE_DIR?.trim() || "artifacts/managed-runtime";
  const filePath = resolve(baseDir, `${kind}-${createdAt.replaceAll(":", "-")}.json`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, payload };
}
