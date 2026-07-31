import { DAEMON_PROVIDER_IDS, type DaemonProvider } from "@dofe-agent/domain";

export type SkillRequirementKind = "provider" | "model" | "capability" | "project" | "config" | "secret";

export interface SkillRequirementDeclaration {
  kind: SkillRequirementKind;
  value: string;
}

export interface SkillRequirementConfiguration {
  modelProvider?: DaemonProvider;
  modelId?: string;
  capabilities: string[];
  projectWorkDir?: string;
  values: Record<string, string>;
  /**
   * Config (`config:`) keys the admin chose to store encrypted at rest instead
   * of as plaintext. Their values are NOT kept in `values`; they live in the
   * encrypted secrets store alongside `secret:` values.
   */
  sensitiveKeys: string[];
}

const SECRET_KEY_PATTERN = /(secret|token|password|(?:api|app)[_-]?key|credential)/i;
const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

export function parseSkillRequirementDeclarations(skillMarkdown: string): SkillRequirementDeclaration[] {
  const frontmatter = readFrontmatter(skillMarkdown);
  if (!frontmatter) {
    return [];
  }

  const declarations: SkillRequirementDeclaration[] = [];
  let inRequires = false;
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    if (/^requires\s*:\s*$/.test(rawLine.trim())) {
      inRequires = true;
      continue;
    }
    if (!inRequires) {
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break;
    }
    const match = rawLine.match(/^\s+-\s+(.+)\s*$/);
    if (!match) {
      if (rawLine.trim()) {
        throw new Error("Skill requires must be a YAML list.");
      }
      continue;
    }
    declarations.push(parseSkillRequirementDeclaration(stripYamlScalar(match[1]!.trim())));
  }
  return uniqueDeclarations(declarations);
}

export function readSkillRequirementDeclarations(configJson: string | undefined): SkillRequirementDeclaration[] {
  const config = readSkillConfig(configJson);
  if (!Array.isArray(config?.requirements)) {
    return [];
  }
  try {
    return uniqueDeclarations(config.requirements.map(parseStoredRequirement));
  } catch {
    return [];
  }
}

export function readSkillRequirementConfiguration(configJson: string | undefined): SkillRequirementConfiguration {
  const config = readSkillConfig(configJson);
  const stored = config?.requirementConfiguration;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { capabilities: [], values: {}, sensitiveKeys: [] };
  }
  const record = stored as Record<string, unknown>;
  const values: Record<string, string> = {};
  if (record.values && typeof record.values === "object" && !Array.isArray(record.values)) {
    for (const [key, value] of Object.entries(record.values)) {
      if (CONFIG_KEY_PATTERN.test(key) && typeof value === "string" && value.length <= 4096) {
        values[key] = value;
      }
    }
  }
  const sensitiveKeys = Array.isArray(record.sensitiveKeys)
    ? record.sensitiveKeys.filter((value): value is string => typeof value === "string" && CONFIG_KEY_PATTERN.test(value))
    : [];
  return {
    modelProvider: typeof record.modelProvider === "string" && isDaemonProvider(record.modelProvider)
      ? record.modelProvider
      : undefined,
    modelId: typeof record.modelId === "string" && isSafeValue(record.modelId) ? record.modelId : undefined,
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((value): value is string => typeof value === "string" && isSafeValue(value))
      : [],
    projectWorkDir: typeof record.projectWorkDir === "string" && isSafeProjectWorkDir(record.projectWorkDir)
      ? record.projectWorkDir
      : undefined,
    values,
    sensitiveKeys,
  };
}

export function serializeSkillRequirementConfiguration(input: {
  configJson: string | undefined;
  configuration: SkillRequirementConfiguration;
}): string {
  const config = readSkillConfig(input.configJson) ?? {};
  return JSON.stringify({
    ...config,
    requirementConfiguration: input.configuration,
  });
}

export function normalizeSkillRequirementConfiguration(input: {
  requirements: SkillRequirementDeclaration[];
  modelProvider?: string;
  modelId?: string;
  capabilities?: string[];
  projectWorkDir?: string;
  values?: Record<string, string>;
  sensitiveKeys?: string[];
}): SkillRequirementConfiguration {
  const providerRequirements = input.requirements.filter((item) => item.kind === "provider").map((item) => item.value);
  const modelRequirements = input.requirements.filter((item) => item.kind === "model").map((item) => item.value);
  const configRequirements = input.requirements.filter((item) => item.kind === "config").map((item) => item.value);
  const capabilityRequirements = input.requirements.filter((item) => item.kind === "capability").map((item) => item.value);
  const needsProject = input.requirements.some((item) => item.kind === "project");
  const selectedProvider = input.modelProvider?.trim();
  const selectedModel = input.modelId?.trim();
  const selectedProject = input.projectWorkDir?.trim();

  if ((providerRequirements.length > 0 || modelRequirements.length > 0) && (!selectedProvider || !isDaemonProvider(selectedProvider))) {
    throw new Error("Select a supported model provider for this skill.");
  }
  if (selectedProvider && providerRequirements.length > 0 && !providerRequirements.includes(selectedProvider)) {
    throw new Error(`This skill requires one of these providers: ${providerRequirements.join(", ")}.`);
  }
  if (modelRequirements.length > 0 && (!selectedModel || !isSafeValue(selectedModel))) {
    throw new Error("Select a valid model identifier for this skill.");
  }
  if (selectedModel && modelRequirements.length > 0 && !modelRequirements.includes(selectedModel)) {
    throw new Error(`This skill requires one of these models: ${modelRequirements.join(", ")}.`);
  }
  if (needsProject && (!selectedProject || !isSafeProjectWorkDir(selectedProject))) {
    throw new Error("Enter a valid project working directory for this skill.");
  }
  const capabilities = Array.from(new Set((input.capabilities ?? []).filter(isSafeValue)));
  for (const capability of capabilityRequirements) {
    if (!capabilities.includes(capability)) {
      throw new Error(`Confirm required model capability ${capability}.`);
    }
  }

  const sensitiveKeySet = new Set((input.sensitiveKeys ?? []).filter((value): value is string => (
    typeof value === "string" && CONFIG_KEY_PATTERN.test(value)
  )));
  for (const key of sensitiveKeySet) {
    if (!configRequirements.includes(key)) {
      throw new Error(`Sensitive flag can only be applied to declared configuration keys.`);
    }
  }

  const values: Record<string, string> = {};
  for (const key of configRequirements) {
    const value = input.values?.[key]?.trim();
    if (!value) {
      // A sensitive config key may be retained from encrypted storage when no
      // new value is supplied (mirrors secret rotation). Its value is resolved
      // from the encrypted store at the persistence layer, not here.
      if (sensitiveKeySet.has(key)) {
        continue;
      }
      throw new Error(`Configuration value ${key} is required.`);
    }
    if (value.length > 4096) {
      throw new Error(`Configuration value ${key} is too long.`);
    }
    values[key] = value;
  }

  return {
    modelProvider: selectedProvider as DaemonProvider | undefined,
    modelId: selectedModel || undefined,
    capabilities,
    projectWorkDir: selectedProject || undefined,
    values,
    sensitiveKeys: Array.from(sensitiveKeySet),
  };
}

export function getSkillRequirementBlockers(input: {
  configJson: string | undefined;
  runtimeProvider?: DaemonProvider;
  /**
   * Keys whose encrypted values are present in the encrypted store. Used to tell
   * whether a sensitive config key is configured, since its value is not held in
   * plaintext `values`. Declared `secret:` keys are always handled by the caller
   * (they unconditionally produce a blocker here and are filtered/re-added).
   */
  configuredEncryptedKeys?: string[];
}): string[] {
  const requirements = readSkillRequirementDeclarations(input.configJson);
  if (requirements.length === 0) {
    return [];
  }
  const configuration = readSkillRequirementConfiguration(input.configJson);
  const blockers: string[] = [];
  const requiredProviders = requirements.filter((item) => item.kind === "provider").map((item) => item.value);
  const requiresModel = requirements.some((item) => item.kind === "model");
  const requiresProject = requirements.some((item) => item.kind === "project");
  const configuredEncrypted = new Set(input.configuredEncryptedKeys ?? []);

  if ((requiredProviders.length > 0 || requiresModel) && !configuration.modelProvider) {
    blockers.push("Select a model provider in the skill setup.");
  }
  if (requiresModel && !configuration.modelId) {
    blockers.push("Select a model in the skill setup.");
  }
  if (requiresProject && !configuration.projectWorkDir) {
    blockers.push("Configure the project working directory in the skill setup.");
  }
  for (const requirement of requirements.filter((item) => item.kind === "capability")) {
    if (!configuration.capabilities.includes(requirement.value)) {
      blockers.push(`Confirm model capability ${requirement.value} in the skill setup.`);
    }
  }
  for (const requirement of requirements.filter((item) => item.kind === "config")) {
    const isSensitive = configuration.sensitiveKeys.includes(requirement.value);
    const isConfigured = isSensitive
      ? configuredEncrypted.has(requirement.value)
      : Boolean(configuration.values[requirement.value]);
    if (!isConfigured) {
      blockers.push(`Configure ${requirement.value} in the skill setup.`);
    }
  }
  for (const requirement of requirements.filter((item) => item.kind === "secret")) {
    blockers.push(`${requirement.value} must be configured in Credential Center.`);
  }
  if (input.runtimeProvider && requiredProviders.length > 0 && !requiredProviders.includes(input.runtimeProvider)) {
    blockers.push(`This skill requires provider ${requiredProviders.join(" or ")}, but the bound runtime uses ${input.runtimeProvider}.`);
  }
  if (input.runtimeProvider && configuration.modelProvider && configuration.modelProvider !== input.runtimeProvider) {
    blockers.push(`The configured model provider ${configuration.modelProvider} does not match the bound runtime provider ${input.runtimeProvider}.`);
  }
  return blockers;
}

export function buildSkillRequirementRuntimeContext(configJson: string | undefined): Record<string, unknown> | undefined {
  const requirements = readSkillRequirementDeclarations(configJson);
  if (requirements.length === 0) {
    return undefined;
  }
  const configuration = readSkillRequirementConfiguration(configJson);
  return {
    version: 1,
    requirements: requirements.map((requirement) => ({
      kind: requirement.kind,
      value: requirement.value,
    })),
    configuration: {
      modelProvider: configuration.modelProvider,
      modelId: configuration.modelId,
      capabilities: configuration.capabilities,
      projectWorkDir: configuration.projectWorkDir,
      sensitiveKeys: configuration.sensitiveKeys,
    },
    credentialRequirements: requirements
      .filter((requirement) => requirement.kind === "secret")
      .map((requirement) => ({ key: requirement.value, status: "credential_center_required" })),
  };
}

function parseSkillRequirementDeclaration(value: string): SkillRequirementDeclaration {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid skill requirement "${value}".`);
  }
  const rawKind = value.slice(0, separator).trim().toLowerCase();
  const requirementValue = value.slice(separator + 1).trim();
  if (!isRequirementKind(rawKind) || !requirementValue) {
    throw new Error(`Unsupported skill requirement "${value}".`);
  }
  let kind: SkillRequirementKind = rawKind;
  if ((kind === "config" || kind === "secret") && !CONFIG_KEY_PATTERN.test(requirementValue)) {
    throw new Error(`Skill ${kind} requirement "${requirementValue}" must be an uppercase key.`);
  }
  if ((kind === "config" || kind === "secret") && requirementValue.startsWith("DOFE_AGENT_")) {
    throw new Error(`Skill environment key ${requirementValue} is reserved by the runtime.`);
  }
  if (kind === "config" && SECRET_KEY_PATTERN.test(requirementValue)) {
    kind = "secret";
  }
  if (kind === "provider" && !isDaemonProvider(requirementValue)) {
    throw new Error(`Unsupported model provider "${requirementValue}".`);
  }
  if (kind !== "config" && kind !== "secret" && !isSafeValue(requirementValue)) {
    throw new Error(`Invalid skill ${kind} requirement "${requirementValue}".`);
  }
  return { kind, value: requirementValue };
}

function parseStoredRequirement(value: unknown): SkillRequirementDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid stored skill requirement.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || typeof record.value !== "string") {
    throw new Error("Invalid stored skill requirement.");
  }
  return parseSkillRequirementDeclaration(`${record.kind}:${record.value}`);
}

function readFrontmatter(skillMarkdown: string): string | undefined {
  return skillMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*/)?.[1];
}

function readSkillConfig(configJson: string | undefined): Record<string, unknown> | undefined {
  if (!configJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(configJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueDeclarations(declarations: SkillRequirementDeclaration[]): SkillRequirementDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((requirement) => {
    const key = `${requirement.kind}:${requirement.value}`.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRequirementKind(value: string): value is SkillRequirementKind {
  return value === "provider" || value === "model" || value === "capability" || value === "project" || value === "config" || value === "secret";
}

function isDaemonProvider(value: string): value is DaemonProvider {
  return DAEMON_PROVIDER_IDS.includes(value as DaemonProvider);
}

function isSafeValue(value: string): boolean {
  return VALUE_PATTERN.test(value);
}

function isSafeProjectWorkDir(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
}

function stripYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
