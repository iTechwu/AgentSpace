import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  readAgentSkillRequirementConfigSync,
  readEffectiveRuntimeEnv,
  upsertAgentSkillRequirementConfigSync,
} from "@dofe-agent/db";
import type { DaemonProvider } from "@dofe-agent/domain";
import { readWorkspaceSkillSync } from "./skills.ts";
import {
  getSkillRequirementBlockers,
  normalizeSkillRequirementConfiguration,
  readSkillRequirementConfiguration,
  readSkillRequirementDeclarations,
  serializeSkillRequirementConfiguration,
  type SkillRequirementConfiguration,
} from "./requirements.ts";

const CREDENTIAL_VERSION = "v1";

export function upsertAgentSkillRequirementsSync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  actorUserId: string;
  modelProvider?: string;
  modelId?: string;
  capabilities?: string[];
  projectWorkDir?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
}): void {
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) throw new Error("Skill does not exist.");
  const requirements = readSkillRequirementDeclarations(skill.configJson);
  const configuration = normalizeSkillRequirementConfiguration({
    requirements,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    capabilities: input.capabilities,
    projectWorkDir: input.projectWorkDir,
    values: input.values,
  });
  const secretNames = requirements.filter((requirement) => requirement.kind === "secret").map((requirement) => requirement.value);
  const encryptedSecrets = encryptDeclaredSecrets(secretNames, input.secrets);
  upsertAgentSkillRequirementConfigSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    configJson: serializeSkillRequirementConfiguration({ configJson: "{}", configuration }),
    encryptedSecretsJson: JSON.stringify(encryptedSecrets),
    actorUserId: input.actorUserId,
  });
}

export function assertAgentSkillRequirementsReadySync(input: {
  workspaceId: string;
  employeeName: string;
  skillIds: string[];
  runtimeProvider?: DaemonProvider;
}): void {
  for (const skillId of new Set(input.skillIds)) {
    const skill = readWorkspaceSkillSync(skillId, input.workspaceId);
    if (!skill) continue;
    const requirements = readSkillRequirementDeclarations(skill.configJson);
    if (requirements.length === 0) continue;
    const record = readAgentSkillRequirementConfigSync({ workspaceId: input.workspaceId, employeeName: input.employeeName, skillId });
    const configuredSecretNames = readEncryptedSecretNames(record?.encryptedSecretsJson);
    const effectiveConfigJson = record?.configJson
      ? JSON.stringify({ ...safeJson(record.configJson), requirements })
      : JSON.stringify({ requirements });
    const blockers = getSkillRequirementBlockers({ configJson: effectiveConfigJson, runtimeProvider: input.runtimeProvider })
      .filter((blocker) => !configuredSecretNames.some((name) => blocker.startsWith(`${name} must be configured`)));
    const missingSecret = requirements
      .filter((requirement) => requirement.kind === "secret" && !configuredSecretNames.includes(requirement.value))
      .map((requirement) => `${requirement.value} must be configured for this agent in Credential Center.`);
    const blocker = [...blockers, ...missingSecret][0];
    if (blocker) throw new Error(`Skill "${skill.name}" is not ready for this agent: ${blocker}`);
  }
}

export function readAgentSkillRequirementConfigurationSync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
}): { configuration?: SkillRequirementConfiguration; configuredSecretKeys: string[] } {
  const record = readAgentSkillRequirementConfigSync(input);
  if (!record) return { configuredSecretKeys: [] };
  const configuration = readSkillRequirementConfiguration(record.configJson);
  return { configuration, configuredSecretKeys: readEncryptedSecretNames(record.encryptedSecretsJson) };
}

export function readAgentSkillRequirementEnvSync(input: {
  workspaceId?: string;
  employeeName: string;
  skillId: string;
}): Record<string, string> {
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) return {};

  const requirements = readSkillRequirementDeclarations(skill.configJson);
  const allowedKeys = new Set(
    requirements
      .filter((requirement) => requirement.kind === "config" || requirement.kind === "secret")
      .map((requirement) => requirement.value),
  );
  if (allowedKeys.size === 0) return {};

  const record = readAgentSkillRequirementConfigSync(input);
  const configuration = record ? readSkillRequirementConfiguration(record.configJson) : undefined;
  const encryptedSecrets = record ? safeJson(record.encryptedSecretsJson ?? "{}") : {};
  const env: Record<string, string> = {};

  for (const key of allowedKeys) {
    if (key.startsWith("DOFE_AGENT_")) continue;

    const configValue = configuration?.values[key];
    if (typeof configValue === "string") {
      env[key] = configValue;
      continue;
    }

    const encryptedValue = encryptedSecrets[key];
    if (typeof encryptedValue === "string" && encryptedValue.startsWith(`${CREDENTIAL_VERSION}:`)) {
      env[key] = decrypt(encryptedValue);
    }
  }

  return env;
}

function decrypt(value: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== CREDENTIAL_VERSION) {
    throw new Error("Unsupported agent skill credential encryption version.");
  }
  const [version, ivBase64, authTagBase64, ciphertextBase64] = parts;
  if (!ivBase64 || !authTagBase64 || !ciphertextBase64) {
    throw new Error("Invalid encrypted agent skill credential format.");
  }
  const key = readEncryptionKey();
  const iv = Buffer.from(ivBase64, "base64url");
  const authTag = Buffer.from(authTagBase64, "base64url");
  const ciphertext = Buffer.from(ciphertextBase64, "base64url");
  if (iv.length !== 12) {
    throw new Error("Invalid agent skill credential initialization vector.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt agent skill credential.");
  }
}

function encryptDeclaredSecrets(secretNames: string[], input: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of secretNames) {
    const value = input?.[name]?.trim();
    if (!value) throw new Error(`${name} must be configured for this agent in Credential Center.`);
    if (value.length > 4096) throw new Error(`${name} is too long.`);
    result[name] = encrypt(value);
  }
  return result;
}

function encrypt(value: string): string {
  const key = readEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [CREDENTIAL_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function readEncryptionKey(): Buffer {
  const env = readEffectiveRuntimeEnv();
  const value = env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY?.trim() || env.DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY is required to store agent skill credentials.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readEncryptedSecretNames(value: string | undefined): string[] {
  const parsed = safeJson(value ?? "{}");
  return Object.entries(parsed)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith(`${CREDENTIAL_VERSION}:`))
    .map(([key]) => key);
}
