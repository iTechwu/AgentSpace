import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  listStoredAgentSkillAssignmentsSync,
  getDatabase,
  readAgentSkillRequirementConfigSync,
  readEffectiveRuntimeEnv,
  readUserSync,
  upsertAgentSkillRequirementConfigSync,
  withTransaction,
} from "@dofe-agent/db";
import type { DaemonProvider } from "@dofe-agent/domain";
import { readWorkspaceSkillSync } from "./skills.ts";
import { listEmployeeSkillIdsSync, setEmployeeSkillIdsSync } from "../employees/employees.ts";
import { readSkillDependencyInstallStatusSync } from "./dependency-install.ts";
import { getManagedRuntimeCredentialEnvKeys } from "../runtime-provisioning/provider-templates.ts";
import {
  getSkillRequirementBlockers,
  normalizeSkillRequirementConfiguration,
  readInvalidSkillRequirementDeclarations,
  readSkillRequirementConfiguration,
  readSkillRequirementDeclarations,
  serializeSkillRequirementConfiguration,
  type SkillRequirementConfiguration,
  type SkillRequirementDeclaration,
} from "./requirements.ts";

const CREDENTIAL_VERSION = "v1";

export type AgentSkillRequirementStatusCode =
  | "skill_ready"
  | "skill_needs_configuration"
  | "skill_runtime_incompatible"
  | "skill_awaiting_validation"
  | "skill_expired";

export interface AgentSkillRequirementSummary {
  skillId: string;
  status: "ready" | "needs_configuration" | "runtime_incompatible" | "awaiting_validation" | "expired";
  /** Stable, queryable status code (spec §6.6). */
  statusDetail: { code: AgentSkillRequirementStatusCode };
  requiredCount: number;
  configuredCount: number;
  blockers: string[];
  environment: Array<{
    key: string;
    kind: "config" | "secret";
    sensitive: boolean;
    configured: boolean;
  }>;
  configuration?: SkillRequirementConfiguration;
  runtimeOnline?: boolean;
  upgradeAddedKeys?: string[];
  /** Requirement keys removed by a skill upgrade (spec §5.3 diff detail). */
  upgradeRemovedKeys?: string[];
  /** Declared keys that may collide with a managed runtime credential when a
   * matching runtime is bound later (spec §0 future-credential-conflict warning). */
  credentialKeyWarnings?: string[];
  /** Declarations that are stored but invalid (e.g. reserved DOFE_AGENT_* keys). */
  invalidDeclarations?: string[];
  /** Declared `capability:` requirements (spec §6.4 — surfaces them for runtime matching). */
  requiredCapabilities?: string[];
  /** GitHub dependency install status for this skill (spec §5.3). */
  dependencyInstallStatus?: import("./dependency-install.ts").SkillDependencyInstallStatus;
  updatedAt?: string;
  updatedBy?: string;
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
  sensitiveKeys?: string[];
  /** Map of declared key -> source skill id to copy an existing configured value from. */
  reuseValues?: Record<string, string>;
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

function resolveReusedAgentSkillRequirementValuesSync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  sensitiveKeys?: string[];
  reuseValues?: Record<string, string>;
}): { values: Record<string, string>; secrets: Record<string, string>; sensitiveKeys: string[] } {
  const values = { ...input.values };
  const secrets = { ...input.secrets };
  const sensitiveKeys = new Set(input.sensitiveKeys ?? []);

  if (!input.reuseValues || Object.keys(input.reuseValues).length === 0) {
    return { values, secrets, sensitiveKeys: Array.from(sensitiveKeys) };
  }

  const targetSkill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!targetSkill) {
    return { values, secrets, sensitiveKeys: Array.from(sensitiveKeys) };
  }
  const targetRequirements = readSkillRequirementDeclarations(targetSkill.configJson);
  const targetKinds = new Map(
    targetRequirements
      .filter((requirement) => requirement.kind === "config" || requirement.kind === "secret")
      .map((requirement) => [requirement.value, requirement.kind]),
  );

  for (const [key, sourceSkillId] of Object.entries(input.reuseValues)) {
    const targetKind = targetKinds.get(key);
    if (!targetKind) continue;

    const sourceSkill = readWorkspaceSkillSync(sourceSkillId, input.workspaceId);
    if (!sourceSkill) continue;
    const sourceRequirements = readSkillRequirementDeclarations(sourceSkill.configJson);
    const sourceDeclaration = sourceRequirements.find(
      (requirement) => (requirement.kind === "config" || requirement.kind === "secret") && requirement.value === key,
    );
    if (!sourceDeclaration || sourceDeclaration.kind !== targetKind) continue;

    const sourceEnv = readAgentSkillRequirementEnvSync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId: sourceSkillId,
    });
    const sourceValue = sourceEnv[key];
    if (sourceValue === undefined) continue;

    if (targetKind === "secret") {
      secrets[key] = sourceValue;
      delete values[key];
      sensitiveKeys.delete(key);
    } else {
      const { configuration: sourceConfiguration } = readAgentSkillRequirementConfigurationSync({
        workspaceId: input.workspaceId,
        employeeName: input.employeeName,
        skillId: sourceSkillId,
      });
      values[key] = sourceValue;
      delete secrets[key];
      if (sourceConfiguration?.sensitiveKeys.includes(key)) {
        sensitiveKeys.add(key);
      }
    }
  }

  return { values, secrets, sensitiveKeys: Array.from(sensitiveKeys) };
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
  sensitiveKeys?: string[];
  reuseValues?: Record<string, string>;
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
  const reused = resolveReusedAgentSkillRequirementValuesSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    values: input.values,
    secrets: input.secrets,
    sensitiveKeys: input.sensitiveKeys,
    reuseValues: input.reuseValues,
  });
  const configuration = normalizeSkillRequirementConfiguration({
    requirements,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    capabilities: input.capabilities,
    projectWorkDir: input.projectWorkDir,
    values: reused.values,
    sensitiveKeys: reused.sensitiveKeys,
  });
  const secretNames = requirements.filter((requirement) => requirement.kind === "secret").map((requirement) => requirement.value);
  // Sensitive config keys are stored encrypted alongside declared secrets; their
  // plaintext values are stripped from the persisted `values` map.
  const sensitiveConfigKeys = configuration.sensitiveKeys;
  const encryptedNames = Array.from(new Set([...secretNames, ...sensitiveConfigKeys]));
  const newEncryptedValues: Record<string, string> = {};
  for (const name of secretNames) {
    newEncryptedValues[name] = reused.secrets?.[name] ?? "";
  }
  for (const name of sensitiveConfigKeys) {
    newEncryptedValues[name] = reused.values?.[name] ?? "";
  }
  const existingRecord = readAgentSkillRequirementConfigSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
  });
  const encrypted = resolveEncryptedValues({
    names: encryptedNames,
    newValues: newEncryptedValues,
    storedEncryptedJson: existingRecord?.encryptedSecretsJson,
  });
  const plaintextValues = Object.fromEntries(
    Object.entries(configuration.values).filter(([key]) => !sensitiveConfigKeys.includes(key)),
  );
  const persistableConfiguration: SkillRequirementConfiguration = {
    ...configuration,
    values: plaintextValues,
  };
  const candidateConfigJson = serializeSkillRequirementConfiguration({
    configJson: skill.configJson,
    configuration: persistableConfiguration,
  });
  const readinessBlocker = getSkillRequirementBlockers({
    configJson: candidateConfigJson,
    runtimeProvider: input.runtimeProvider,
    configuredEncryptedKeys: Object.keys(encrypted.encrypted),
  }).find((blocker) => !secretNames.some((name) => blocker.startsWith(`${name} must be configured`)));
  if (readinessBlocker) {
    throw new Error(`Skill "${skill.name}" is not ready for this agent: ${readinessBlocker}`);
  }
  assertNoInstalledSkillEnvironmentConflicts({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    candidateEnv: { ...plaintextValues, ...encrypted.plaintext },
  });
  upsertAgentSkillRequirementConfigSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
    configJson: JSON.stringify({
      requirementConfiguration: persistableConfiguration,
      requirementSignature: requirementSignatureFor(requirements),
    }),
    encryptedSecretsJson: JSON.stringify(encrypted.encrypted),
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
  // The encrypted store holds both declared `secret:` values and sensitive
  // `config:` values, so its key set is the set of configured encrypted keys.
  const configuredEncryptedKeys = readEncryptedSecretNames(record?.encryptedSecretsJson);
  const configuration = record ? readSkillRequirementConfiguration(record.configJson) : undefined;
  const effectiveConfigJson = record?.configJson
    ? JSON.stringify({ ...safeJson(record.configJson), requirements })
    : JSON.stringify({ requirements });
  const blockers = getSkillRequirementBlockers({
    configJson: effectiveConfigJson,
    runtimeProvider: input.runtimeProvider,
    configuredEncryptedKeys,
  }).filter((blocker) => !configuredEncryptedKeys.some((name) => blocker.startsWith(`${name} must be configured`)));
  blockers.push(...requirements
    .filter((requirement) => requirement.kind === "secret" && !configuredEncryptedKeys.includes(requirement.value))
    .map((requirement) => `${requirement.value} must be configured for this agent in Credential Center.`));

  const environment = requirements
    .filter((requirement): requirement is typeof requirement & { kind: "config" | "secret" } => (
      requirement.kind === "config" || requirement.kind === "secret"
    ))
    .map((requirement) => {
      const sensitive = requirement.kind === "config"
        ? Boolean(configuration?.sensitiveKeys.includes(requirement.value))
        : true;
      const configured = sensitive
        ? configuredEncryptedKeys.includes(requirement.value)
        : Boolean(configuration?.values[requirement.value]);
      return { key: requirement.value, kind: requirement.kind, sensitive, configured };
    });
  const runtimeIncompatible = blockers.some((blocker) => (
    blocker.includes("bound runtime uses") || blocker.includes("does not match the bound runtime provider")
  ));
  const currentSignature = requirementSignatureFor(requirements);
  const savedSignature = record ? readSavedRequirementSignature(record.configJson) : [];
  const upgradeAddedKeys = record
    ? currentSignature.filter((key) => !savedSignature.includes(key))
    : [];
  const upgradeRemovedKeys = record
    ? savedSignature.filter((key) => !currentSignature.includes(key))
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

  const updatedBy = record?.updatedByUserId
    ? readUserSync(record.updatedByUserId)?.displayName
    : undefined;

  const statusDetailCode: AgentSkillRequirementStatusCode = status === "ready"
    ? "skill_ready"
    : status === "needs_configuration"
      ? "skill_needs_configuration"
      : status === "runtime_incompatible"
        ? "skill_runtime_incompatible"
        : status === "awaiting_validation"
          ? "skill_awaiting_validation"
          : "skill_expired";

  const invalidDeclarations = readInvalidSkillRequirementDeclarations(skill.configJson);
  const summary: AgentSkillRequirementSummary = {
    skillId: input.skillId,
    status,
    statusDetail: { code: statusDetailCode },
    requiredCount: environment.length,
    configuredCount: environment.filter((item) => item.configured).length,
    blockers,
    environment,
    configuration,
    runtimeOnline: input.runtimeOnline,
    upgradeAddedKeys,
    upgradeRemovedKeys,
    updatedAt: record?.updatedAt,
    updatedBy,
  };
  if (invalidDeclarations.length > 0) {
    summary.invalidDeclarations = invalidDeclarations;
  }
  const requiredCapabilities = requirements
    .filter((requirement) => requirement.kind === "capability")
    .map((requirement) => requirement.value);
  if (requiredCapabilities.length > 0) {
    summary.requiredCapabilities = requiredCapabilities;
  }
  const dependencyInstallStatus = readSkillDependencyInstallStatusSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    skillId: input.skillId,
  });
  if (dependencyInstallStatus !== "none") {
    summary.dependencyInstallStatus = dependencyInstallStatus;
  }
  const managedCredentialKeys = new Set(getManagedRuntimeCredentialEnvKeys());
  const credentialKeyWarnings = environment
    .map((item) => item.key)
    .filter((key) => managedCredentialKeys.has(key));
  if (credentialKeyWarnings.length > 0) {
    summary.credentialKeyWarnings = credentialKeyWarnings;
  }
  return summary;
}

/**
 * Resolves the project working directory declared by this employee's
 * project-requiring skills. Mirrors model resolution: returns a value only when
 * every project-requiring skill agrees on the same directory (unanimous
 * consensus), otherwise `undefined` so the task keeps its default staged cwd.
 */
export function resolveSkillProjectWorkDirSync(workspaceId: string, employeeName: string): string | undefined {
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  const projectDirs = new Set<string>();
  for (const skillId of skillIds) {
    const skill = readWorkspaceSkillSync(skillId, workspaceId);
    if (!skill) continue;
    const requirements = readSkillRequirementDeclarations(skill.configJson);
    if (!requirements.some((requirement) => requirement.kind === "project")) continue;
    const { configuration } = readAgentSkillRequirementConfigurationSync({ workspaceId, employeeName, skillId });
    const dir = configuration?.projectWorkDir?.trim();
    if (dir) projectDirs.add(dir);
  }
  return projectDirs.size === 1 ? [...projectDirs][0] : undefined;
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

/**
 * Removes a single environment variable from an installed skill's configuration.
 * Deleting a declared required key intentionally leaves the skill in
 * `needs_configuration` (recomputed by the summary on next read). The returned
 * `sensitive` flag tells the caller whether an encrypted value was discarded.
 */
export function deleteAgentSkillRequirementKeySync(input: {
  workspaceId: string;
  employeeName: string;
  skillId: string;
  key: string;
  actorUserId: string;
}): { kind: "config" | "secret"; sensitive: boolean } {
  return withEmployeeSkillMutationLockSync(input.workspaceId, input.employeeName, () => {
    const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
    if (!skill) throw new Error("Skill does not exist.");
    const record = readAgentSkillRequirementConfigSync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId: input.skillId,
    });
    if (!record) throw new Error("No configuration stored for this skill.");

    const requirements = readSkillRequirementDeclarations(skill.configJson);
    const declaration = requirements.find(
      (requirement) => (requirement.kind === "config" || requirement.kind === "secret") && requirement.value === input.key,
    );
    if (!declaration) {
      throw new Error(`${input.key} is not a declared environment variable for this skill.`);
    }

    const configuration = readSkillRequirementConfiguration(record.configJson);
    const encryptedStore = safeJson(record.encryptedSecretsJson ?? "{}");
    const sensitive = declaration.kind === "secret"
      ? true
      : configuration.sensitiveKeys.includes(input.key);

    const nextValues = { ...configuration.values };
    delete nextValues[input.key];
    const nextSensitiveKeys = configuration.sensitiveKeys.filter((value) => value !== input.key);
    if (typeof encryptedStore[input.key] === "string") {
      delete encryptedStore[input.key];
    }

    const persistableConfiguration: SkillRequirementConfiguration = {
      ...configuration,
      values: nextValues,
      sensitiveKeys: nextSensitiveKeys,
    };
    const storedConfig = safeJson(record.configJson);
    upsertAgentSkillRequirementConfigSync({
      workspaceId: input.workspaceId,
      employeeName: input.employeeName,
      skillId: input.skillId,
      configJson: JSON.stringify({ ...storedConfig, requirementConfiguration: persistableConfiguration }),
      encryptedSecretsJson: JSON.stringify(encryptedStore),
      actorUserId: input.actorUserId,
    });
    return { kind: declaration.kind === "secret" ? "secret" : "config", sensitive };
  });
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

function resolveEncryptedValues(input: {
  names: string[];
  newValues: Record<string, string>;
  storedEncryptedJson: string | undefined;
}): { encrypted: Record<string, string>; plaintext: Record<string, string> } {
  const stored = safeJson(input.storedEncryptedJson ?? "{}");
  const encrypted: Record<string, string> = {};
  const plaintext: Record<string, string> = {};
  for (const name of input.names) {
    const value = input.newValues[name]?.trim();
    if (value) {
      if (value.length > 4096) throw new Error(`${name} is too long.`);
      encrypted[name] = encrypt(value);
      plaintext[name] = value;
      continue;
    }
    const storedValue = stored[name];
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
