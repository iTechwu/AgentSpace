import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  listStoredAgentSkillAssignmentsSync,
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

export interface AgentSkillRequirementSummary {
  skillId: string;
  status: "ready" | "needs_configuration" | "runtime_incompatible";
  requiredCount: number;
  configuredCount: number;
  blockers: string[];
  environment: Array<{
    key: string;
    kind: "config" | "secret";
    configured: boolean;
  }>;
  configuration?: SkillRequirementConfiguration;
  updatedAt?: string;
}

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
  managedRuntimeCredentialKey?: string;
}): void {
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) throw new Error("Skill does not exist.");
  const requirements = readSkillRequirementDeclarations(skill.configJson);
  if (
    input.managedRuntimeCredentialKey
    && requirements.some((requirement) => (
      (requirement.kind === "config" || requirement.kind === "secret")
      && requirement.value === input.managedRuntimeCredentialKey
    ))
  ) {
    throw new Error(`${input.managedRuntimeCredentialKey} is managed by the bound runtime and cannot be configured by a Skill.`);
  }
  const configuration = normalizeSkillRequirementConfiguration({
    requirements,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    capabilities: input.capabilities,
    projectWorkDir: input.projectWorkDir,
    values: input.values,
  });
  const secretNames = requirements.filter((requirement) => requirement.kind === "secret").map((requirement) => requirement.value);
  const existingRecord = readAgentSkillRequirementConfigSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
  });
  const secrets = resolveDeclaredSecrets(secretNames, input.secrets, existingRecord?.encryptedSecretsJson);
  assertNoInstalledSkillEnvironmentConflicts({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    candidateEnv: { ...configuration.values, ...secrets.plaintext },
  });
  upsertAgentSkillRequirementConfigSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    configJson: serializeSkillRequirementConfiguration({ configJson: "{}", configuration }),
    encryptedSecretsJson: JSON.stringify(secrets.encrypted),
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
    const blocker = readAgentSkillRequirementSummarySync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId,
      runtimeProvider: input.runtimeProvider,
    }).blockers[0];
    if (blocker) throw new Error(`Skill "${skill.name}" is not ready for this agent: ${blocker}`);
  }
}

export function readAgentSkillRequirementSummarySync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  runtimeProvider?: DaemonProvider;
}): AgentSkillRequirementSummary {
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) throw new Error("Skill does not exist.");
  const requirements = readSkillRequirementDeclarations(skill.configJson);
  const record = readAgentSkillRequirementConfigSync(input);
  const configuredSecretNames = readEncryptedSecretNames(record?.encryptedSecretsJson);
  const configuration = record ? readSkillRequirementConfiguration(record.configJson) : undefined;
  const effectiveConfigJson = record?.configJson
    ? JSON.stringify({ ...safeJson(record.configJson), requirements })
    : JSON.stringify({ requirements });
  const blockers = getSkillRequirementBlockers({
    configJson: effectiveConfigJson,
    runtimeProvider: input.runtimeProvider,
  }).filter((blocker) => !configuredSecretNames.some((name) => blocker.startsWith(`${name} must be configured`)));
  blockers.push(...requirements
    .filter((requirement) => requirement.kind === "secret" && !configuredSecretNames.includes(requirement.value))
    .map((requirement) => `${requirement.value} must be configured for this agent in Credential Center.`));

  const environment = requirements
    .filter((requirement): requirement is typeof requirement & { kind: "config" | "secret" } => (
      requirement.kind === "config" || requirement.kind === "secret"
    ))
    .map((requirement) => ({
      key: requirement.value,
      kind: requirement.kind,
      configured: requirement.kind === "config"
        ? Boolean(configuration?.values[requirement.value])
        : configuredSecretNames.includes(requirement.value),
    }));
  const runtimeIncompatible = blockers.some((blocker) => (
    blocker.includes("bound runtime uses") || blocker.includes("does not match the bound runtime provider")
  ));

  return {
    skillId: input.skillId,
    status: runtimeIncompatible ? "runtime_incompatible" : blockers.length > 0 ? "needs_configuration" : "ready",
    requiredCount: environment.length,
    configuredCount: environment.filter((item) => item.configured).length,
    blockers,
    environment,
    configuration,
    updatedAt: record?.updatedAt,
  };
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

function assertNoInstalledSkillEnvironmentConflicts(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  candidateEnv: Record<string, string>;
}): void {
  const assignedSkills = listStoredAgentSkillAssignmentsSync(input.workspaceId)
    .filter((assignment) => assignment.employeeName === input.employeeName.trim() && assignment.skillId !== input.skillId);
  for (const assignment of assignedSkills) {
    const installedEnv = readAgentSkillRequirementEnvSync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId: assignment.skillId,
    });
    for (const [key, value] of Object.entries(input.candidateEnv)) {
      if (installedEnv[key] === undefined || installedEnv[key] === value) continue;
      const installedSkill = readWorkspaceSkillSync(assignment.skillId, input.workspaceId);
      throw new Error(
        `Skill environment variable ${key} conflicts with installed Skill "${installedSkill?.name ?? assignment.skillId}". `
        + "Use the same value or update the installed Skill first.",
      );
    }
  }
}

function resolveDeclaredSecrets(
  secretNames: string[],
  input: Record<string, string> | undefined,
  storedSecretsJson: string | undefined,
): { encrypted: Record<string, string>; plaintext: Record<string, string> } {
  const storedSecrets = safeJson(storedSecretsJson ?? "{}");
  const encrypted: Record<string, string> = {};
  const plaintext: Record<string, string> = {};
  for (const name of secretNames) {
    const value = input?.[name]?.trim();
    if (value) {
      if (value.length > 4096) throw new Error(`${name} is too long.`);
      encrypted[name] = encrypt(value);
      plaintext[name] = value;
      continue;
    }
    const storedValue = storedSecrets[name];
    if (typeof storedValue !== "string" || !storedValue.startsWith(`${CREDENTIAL_VERSION}:`)) {
      throw new Error(`${name} must be configured for this agent in Credential Center.`);
    }
    encrypted[name] = storedValue;
    plaintext[name] = decrypt(storedValue);
  }
  return { encrypted, plaintext };
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
