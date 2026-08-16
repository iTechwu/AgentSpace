// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  readExternalIntegrationSync,
  type ExternalIntegrationRecord,
  type ExternalIntegrationTransportMode
} from "@dofe-agent/db";
import {
  FEISHU_PROVIDER_ID
} from "@dofe-agent/services";
import { getStringFlag } from "../../../lib/args.ts";
import type { FeishuIntegrationReadiness } from "./types.ts";

export function readStringFlagByKeys(
  flags: Record<string, string | boolean>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = getStringFlag(flags, key);
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
export function copyStringFlagAsParameter(
  flags: Record<string, string | boolean>,
  parameters: Record<string, unknown>,
  flag: string,
  parameter: string,
): void {
  const value = normalizeOptionalText(getStringFlag(flags, flag));
  if (value) {
    parameters[parameter] = value;
  }
}
export function copyJsonFlagAsParameter(
  flags: Record<string, string | boolean>,
  parameters: Record<string, unknown>,
  flag: string,
  parameter: string,
): void {
  const value = getStringFlag(flags, flag);
  if (value === undefined) {
    return;
  }
  try {
    parameters[parameter] = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`feishu.data_operation.invalid_${flag.replace(/-/g, "_")}`);
  }
}
export function getOptionalNumberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = getStringFlag(flags, key);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`feishu.data_operation.invalid_${key.replace(/-/g, "_")}`);
  }
  return parsed;
}
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
export function readStringFromRecord(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
export function readNumberFromRecord(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
export function requireActiveFeishuCliIntegration(input: {
  workspaceId: string;
  integrationId: string;
  readIntegration: typeof readExternalIntegrationSync;
}): ExternalIntegrationRecord {
  const integration = input.readIntegration({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
  });
  if (!integration || integration.provider !== FEISHU_PROVIDER_ID) {
    throw new Error("feishu.integration.not_found");
  }
  if (integration.status !== "active") {
    throw new Error("feishu.integration.not_active");
  }
  return integration;
}
export function requireCliIntegrationId(value: string | undefined): string {
  return requireNonEmpty(value, "feishu.integration.missing_integration_id");
}
export function requireStringFlagValue(input: {
  flags: Record<string, string | boolean>;
  keys: string[];
  missingCode: string;
}): string {
  for (const key of input.keys) {
    const value = normalizeOptionalText(getStringFlag(input.flags, key));
    if (value) {
      return value;
    }
  }
  throw new Error(input.missingCode);
}
export function requireStringFlag(flags: Record<string, string | boolean>, key: string): string {
  return requireNonEmpty(getStringFlag(flags, key), `feishu.cli.missing_${key.replace(/-/g, "_")}`);
}
export function requireStringFlagOrEnv(input: {
  flags: Record<string, string | boolean>;
  flagKeys: string[];
  envFlagKeys: string[];
  defaultEnvNames: string[];
  missingCode: string;
  env?: Record<string, string | undefined>;
}): string {
  const value = readStringFlagOrEnv(input);
  if (!value) {
    throw new Error(input.missingCode);
  }
  return value;
}
export function readStringFlagOrEnv(input: {
  flags: Record<string, string | boolean>;
  flagKeys: string[];
  envFlagKeys: string[];
  defaultEnvNames: string[];
  env?: Record<string, string | undefined>;
}): string | undefined {
  const env = input.env ?? process.env;
  for (const key of input.flagKeys) {
    const value = normalizeOptionalText(getStringFlag(input.flags, key));
    if (value) {
      return value;
    }
  }
  for (const key of input.envFlagKeys) {
    const envName = normalizeOptionalText(getStringFlag(input.flags, key));
    if (!envName) {
      continue;
    }
    const value = normalizeOptionalText(env[envName]);
    if (!value) {
      throw new Error(`feishu.cli.missing_env_value:${envName}`);
    }
    return value;
  }
  for (const envName of input.defaultEnvNames) {
    const value = normalizeOptionalText(env[envName]);
    if (value) {
      return value;
    }
  }
  return undefined;
}
export function parseFeishuCliEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`feishu.cli.invalid_env_file_line:${index + 1}`);
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`feishu.cli.invalid_env_name:${index + 1}`);
    }
    values[key] = parseFeishuCliEnvFileValue(normalizedLine.slice(separatorIndex + 1).trim(), index + 1);
  }
  return values;
}
export function parseFeishuCliEnvFileValue(value: string, lineNumber: number): string {
  if (!value) {
    return "";
  }
  const quote = value[0];
  if (quote === "\"" || quote === "'") {
    let escaped = false;
    let output = "";
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        output += char === "n" && quote === "\"" ? "\n" : char;
        escaped = false;
        continue;
      }
      if (char === "\\" && quote === "\"") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return output;
      }
      output += char;
    }
    throw new Error(`feishu.cli.invalid_env_file_quote:${lineNumber}`);
  }

  const commentIndex = value.indexOf(" #");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}
export function requireNonEmpty(value: string | undefined, errorCode: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(errorCode);
  }
  return normalized;
}
export function requireNonPlaceholderFeishuCreateValue(field: string, value: string): string {
  if (isFeishuCreatePlaceholderValue(value)) {
    throw new Error(`feishu.create.placeholder_value:${field}`);
  }
  return value;
}
export function requireNonPlaceholderFeishuAgentBotValue(field: string, value: string): string {
  if (isFeishuCliPlaceholderValue(value)) {
    throw new Error(`feishu.agent_bot_binding.placeholder_value:${field}`);
  }
  return value;
}
export function requireNonPlaceholderFeishuBindingValue(value: string, errorCode: string): string {
  if (isFeishuCliPlaceholderValue(value)) {
    throw new Error(errorCode);
  }
  return value;
}
export function validateOptionalFeishuBindingValue(value: string | undefined, errorCode: string): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (normalized && isFeishuCliPlaceholderValue(normalized)) {
    throw new Error(errorCode);
  }
  return normalized;
}
export function validateOptionalFeishuCreateValue(field: string, value: string | undefined): string | undefined {
  if (value && isFeishuCreatePlaceholderValue(value)) {
    throw new Error(`feishu.create.placeholder_value:${field}`);
  }
  return value;
}
export function validateOptionalFeishuAgentBotValue(field: string, value: string | undefined): string | undefined {
  if (value && isFeishuCliPlaceholderValue(value)) {
    throw new Error(`feishu.agent_bot_binding.placeholder_value:${field}`);
  }
  return value;
}
export function isFeishuCreatePlaceholderValue(value: string): boolean {
  return isFeishuCliPlaceholderValue(value);
}
export function isFeishuCliPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const tokenized = normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (tokenized.startsWith("change_me") || tokenized.startsWith("replace_me")) {
    return true;
  }
  if (tokenized === "xxx" || tokenized === "todo" || tokenized === "placeholder") {
    return true;
  }
  return /(^|_)xxx($|_)/.test(tokenized) ||
    /(^|_)(todo|placeholder)($|_)/.test(tokenized);
}
export function parseFeishuCliTransportMode(value: string | undefined): ExternalIntegrationTransportMode {
  const normalized = normalizeOptionalText(value) ?? "http_webhook";
  if (normalized === "http_webhook" || normalized === "http-webhook" || normalized === "webhook" || normalized === "http") {
    return "http_webhook";
  }
  if (
    normalized === "websocket_worker" ||
    normalized === "websocket-worker" ||
    normalized === "websocket" ||
    normalized === "worker"
  ) {
    return "websocket_worker";
  }
  throw new Error("feishu.create.invalid_transport_mode");
}
export function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}
export function sameValue(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
export function formatIntegrationLabel(candidate: FeishuIntegrationReadiness | undefined): string {
  if (!candidate) {
    return "the selected Feishu integration";
  }
  return `${candidate.displayName} (${candidate.id})`;
}
export function hasBooleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  return value === true || value === "true" || value === "1";
}
export function hasHelpFlag(flags: Record<string, string | boolean>): boolean {
  return flags.help === true || flags.h === true;
}
