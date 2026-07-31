import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  listStoredAgentSkillAssignmentsSync,
  getDatabase,
  readAgentSkillRequirementConfigSync,
  readEffectiveRuntimeEnv,
  upsertAgentSkillRequirementConfigSync,
  withTransaction,
} from "@dofe-agent/db";
import type { DaemonProvider } from "@dofe-agent/domain";
import { readWorkspaceSkillSync } from "./skills.ts";
import { setEmployeeSkillIdsSync } from "../employees/employees.ts";
import {
  getSkillRequirementBlockers,
  normalizeSkillRequirementConfiguration,
  readSkillRequirementConfiguration,
  readSkillRequirementDeclarations,
  serializeSkillRequirementConfiguration,
  type SkillRequirementConfiguration,
  type SkillRequirementDeclaration,
} from "./requirements.ts";

const CREDENTIAL_VERSION = "v1";

export interface AgentSkillRequirementSummary {
  skillId: string;
  status: "ready" | "needs_configuration" | "runtime_incompatible" | "awaiting_validation" | "expired";
  requiredCount: number;
  configuredCount: number;
  blockers: string[];
  environment: Array<{
    key: string;
    kind: "config" | "secret";
    configured: boolean;
  }>;
  configuration?: SkillRequirementConfiguration;
  runtimeOnline?: boolean;
  upgradeAddedKeys?: string[];
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
  runtimeProvider?: DaemonProvider;
  assignSkill?: boolean;
}): string[] | undefined {
  if (input.assignSkill) {
    return withEmployeeSkillMutationLockSync(input.workspaceId, input.employeeName, () => {
      persistAgentSkillRequirementsSync(input);
      const skillIds = [...new Set([
        ...listStoredAgentSkillAssignmentsSync(input.workspaceId)
          .filter((assignment) => assignment.employeeName === input.employeeName.trim())
          .map((assignment) => assignment.skillId),
        input.skillId.trim(),
      ])];
      setEmployeeSkillIdsSync(input.employeeName, skillIds, input.workspaceId);
      return skillIds;
    });
  }
  persistAgentSkillRequirementsSync(input);
  return undefined;
}

function persistAgentSkillRequirementsSync(input: {
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
  runtimeProvider?: DaemonProvider;
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
  const candidateConfigJson = serializeSkillRequirementConfiguration({
    configJson: skill.configJson,
    configuration,
  });
  const readinessBlocker = getSkillRequirementBlockers({
    configJson: candidateConfigJson,
    runtimeProvider: input.runtimeProvider,
  }).find((blocker) => !secretNames.some((name) => blocker.startsWith(`${name} must be configured`)));
  if (readinessBlocker) {
    throw new Error(`Skill "${skill.name}" is not ready for this agent: ${readinessBlocker}`);
  }
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
    configJson: JSON.stringify({
      requirementConfiguration: configuration,
      requirementSignature: requirementSignatureFor(requirements),
    }),
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
  const resolvedEnvironment = new Map<string, { value: string; skillName: string }>();
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
    const environment = readAgentSkillRequirementEnvSync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId,
    });
    for (const [key, value] of Object.entries(environment)) {
      const existing = resolvedEnvironment.get(key);
      if (existing && existing.value !== value) {
        throw new Error(
          `Skill environment variable ${key} conflicts between Skill "${existing.skillName}" and Skill "${skill.name}". `
          + "Use the same value or remove one of the Skills.",
        );
      }
      resolvedEnvironment.set(key, { value, skillName: skill.name });
    }
  }
}

export function setAgentSkillAssignmentsWithRequirementsValidationSync(input: {
  workspaceId: string;
  employeeName: string;
  skillIds: string[];
  runtimeProvider?: DaemonProvider;
}): ReturnType<typeof setEmployeeSkillIdsSync> {
  return withEmployeeSkillMutationLockSync(input.workspaceId, input.employeeName, () => {
    assertAgentSkillRequirementsReadySync(input);
    return setEmployeeSkillIdsSync(input.employeeName, input.skillIds, input.workspaceId);
  });
}

export function readAgentSkillRequirementSummarySync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  runtimeProvider?: DaemonProvider;
  runtimeOnline?: boolean;
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
  const currentSignature = requirementSignatureFor(requirements);
  const savedSignature = record ? readSavedRequirementSignature(record.configJson) : [];
  const upgradeAddedKeys = record
    ? currentSignature.filter((key) => !savedSignature.includes(key))
    : [];

  let status: AgentSkillRequirementSummary["status"];
  if (upgradeAddedKeys.length > 0) {
    status = "expired";
  } else if (runtimeIncompatible) {
    status = "runtime_incompatible";
  } else if (blockers.length > 0) {
    status = "needs_configuration";
  } else if (input.runtimeOnline === false && requirements.length > 0) {
    status = "awaiting_validation";
  } else {
    status = "ready";
  }

  return {
    skillId: input.skillId,
    status,
    requiredCount: environment.length,
    configuredCount: environment.filter((item) => item.configured).length,
    blockers,
    environment,
    configuration,
    runtimeOnline: input.runtimeOnline,
    upgradeAddedKeys,
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

function requirementSignatureFor(requirements: SkillRequirementDeclaration[]): string[] {
  return Array.from(new Set(
    requirements
      .filter((requirement) => requirement.kind === "config" || requirement.kind === "secret")
      .map((requirement) => requirement.value),
  )).sort((left, right) => left.localeCompare(right));
}

function readSavedRequirementSignature(configJson: string | undefined): string[] {
  const config = safeJson(configJson ?? "{}");
  const signature = config.requirementSignature;
  return Array.isArray(signature)
    ? signature.filter((value): value is string => typeof value === "string")
    : [];
}

function withEmployeeSkillMutationLockSync<T>(
  workspaceId: string,
  employeeName: string,
  work: () => T,
): T {
  const db = getDatabase();
  return withTransaction(db, () => {
    const employeeRow = db.prepare(
      `SELECT name FROM workspace_employee
       WHERE workspace_id = ? AND LOWER(name) = LOWER(?)
       FOR UPDATE`,
    ).get(workspaceId, employeeName.trim());
    if (!employeeRow) throw new Error(`Active employee "${employeeName}" does not exist.`);
    return work();
  });
}
