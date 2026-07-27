import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const PROFILE_VERSION = 1;
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "PATH",
  "NODE_OPTIONS",
  "DOFE_AGENT_DAEMON_TOKEN",
  "DOFE_AGENT_SERVER_URL",
  "DOFE_AGENT_PROVIDER_ACCOUNT_ID",
  "DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT",
  "DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF",
]);
const PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY",
  "OPENCLAW_API_KEY", "NANOBOT_API_KEY", "HERMES_API_KEY",
];

export interface ProviderCredentialProfile {
  accountId: string;
  profileDir: string;
  environment: Record<string, string>;
}

export class ProviderCredentialResolver {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  resolve(environment: NodeJS.ProcessEnv = process.env): ProviderCredentialProfile | null {
    const accountId = environment.DOFE_AGENT_PROVIDER_ACCOUNT_ID?.trim();
    if (!accountId) return null;

    const credentialRoot = environment.DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT?.trim();
    const credentialMapRef = environment.DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF?.trim();
    if (!credentialRoot || !credentialMapRef) {
      throw new Error("Provider account credentials require DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT and DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF on this node.");
    }
    const references = readCredentialMap(credentialMapRef, credentialRoot, accountId);
    const profileDir = resolve(this.stateDir, "provider-accounts", normalizeAccountId(accountId));
    const config = references.configRef ? readCredentialDocument(references.configRef, credentialRoot) : emptyDocument();
    const secret = references.secretRef ? readCredentialDocument(references.secretRef, credentialRoot) : emptyDocument();
    const document = mergeDocuments(config, secret);
    const nextProfileDir = `${profileDir}.next-${process.pid}`;
    rmSync(nextProfileDir, { recursive: true, force: true });
    mkdirSync(nextProfileDir, { recursive: true, mode: 0o700 });
    chmodSync(nextProfileDir, 0o700);
    for (const [relativePath, content] of Object.entries(document.files)) {
      const destination = resolveProfileFilePath(nextProfileDir, relativePath);
      mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(destination, content, { encoding: "utf8", mode: 0o600 });
      chmodSync(destination, 0o600);
    }
    rmSync(profileDir, { recursive: true, force: true });
    renameSync(nextProfileDir, profileDir);

    return {
      accountId,
      profileDir,
      environment: {
        ...document.environment,
        DOFE_AGENT_PROVIDER_PROFILE_DIR: profileDir,
        HOME: profileDir,
      },
    };
  }
}

export function resolveProviderCredentialProfile(input: {
  stateDir: string;
  environment?: NodeJS.ProcessEnv;
}): ProviderCredentialProfile | null {
  return new ProviderCredentialResolver(input.stateDir).resolve(input.environment);
}

export function applyProviderCredentialProfile(profile: ProviderCredentialProfile, environment: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(profile.environment)) {
    environment[key] = value;
  }
  for (const key of PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS) {
    if (!(key in profile.environment)) delete environment[key];
  }
  delete environment.DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT;
  delete environment.DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF;
}

interface CredentialDocument {
  version: number;
  environment: Record<string, string>;
  files: Record<string, string>;
}

interface ProviderCredentialReferences {
  configRef?: string;
  secretRef?: string;
}

function readCredentialMap(reference: string, credentialRoot: string, accountId: string): ProviderCredentialReferences {
  const filePath = resolveCredentialReference(reference, credentialRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Provider credential map must contain JSON: ${reference}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.accounts) || !isRecord(parsed.accounts[accountId])) {
    throw new Error(`Provider account ${accountId} has no credential mapping on this node.`);
  }
  const account = parsed.accounts[accountId];
  const configRef = typeof account.configRef === "string" ? account.configRef : undefined;
  const secretRef = typeof account.secretRef === "string" ? account.secretRef : undefined;
  if (!configRef && !secretRef) throw new Error(`Provider account ${accountId} has no config or secret reference on this node.`);
  return { configRef, secretRef };
}

function readCredentialDocument(reference: string, credentialRoot: string): CredentialDocument {
  const filePath = resolveCredentialReference(reference, credentialRoot);
  if (!existsSync(filePath)) throw new Error(`Provider credential reference does not exist: ${reference}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Provider credential reference must contain JSON: ${reference}`);
  }
  return parseCredentialDocument(parsed, reference);
}

function parseCredentialDocument(value: unknown, reference: string): CredentialDocument {
  if (!isRecord(value)) throw new Error(`Provider credential document must be an object: ${reference}`);
  const version = value.version === undefined ? PROFILE_VERSION : value.version;
  if (version !== PROFILE_VERSION) throw new Error(`Unsupported provider credential document version: ${reference}`);
  return {
    version,
    environment: parseStringMap(value.environment, reference, "environment", validateEnvironmentKey),
    files: parseStringMap(value.files, reference, "files", validateFilePath),
  };
}

function parseStringMap(
  value: unknown,
  reference: string,
  field: string,
  validateKey: (key: string) => void,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Provider credential ${field} must be an object: ${reference}`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    validateKey(key);
    if (typeof entry !== "string") throw new Error(`Provider credential ${field}.${key} must be a string: ${reference}`);
    result[key] = entry;
  }
  return result;
}

function resolveCredentialReference(reference: string, credentialRoot: string): string {
  if (!reference.startsWith("file://")) throw new Error(`Unsupported provider credential reference scheme: ${reference}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(reference).pathname);
  } catch {
    throw new Error(`Invalid provider credential reference: ${reference}`);
  }
  const configuredRoot = resolve(credentialRoot);
  const referencePath = resolve(pathname);
  if (!isContainedBy(configuredRoot, referencePath)) {
    throw new Error(`Provider credential reference must stay within DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: ${reference}`);
  }
  if (!existsSync(configuredRoot) || !existsSync(referencePath)) {
    throw new Error(`Provider credential reference does not exist: ${reference}`);
  }
  const root = realpathSync(configuredRoot);
  const filePath = realpathSync(referencePath);
  if (!isContainedBy(root, filePath)) {
    throw new Error(`Provider credential reference must stay within DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: ${reference}`);
  }
  return filePath;
}

function resolveProfileFilePath(profileDir: string, relativePath: string): string {
  const filePath = resolve(profileDir, relativePath);
  if (!isContainedBy(profileDir, filePath)) throw new Error(`Provider credential file path escapes its runtime profile: ${relativePath}`);
  return filePath;
}

function mergeDocuments(config: CredentialDocument, secret: CredentialDocument): CredentialDocument {
  return {
    version: PROFILE_VERSION,
    environment: { ...config.environment, ...secret.environment },
    files: { ...config.files, ...secret.files },
  };
}

function emptyDocument(): CredentialDocument {
  return { version: PROFILE_VERSION, environment: {}, files: {} };
}

function normalizeAccountId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Provider account id is invalid for a credential profile.");
  return value;
}

function validateEnvironmentKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || BLOCKED_ENVIRONMENT_KEYS.has(key)) {
    throw new Error(`Provider credential environment key is not allowed: ${key}`);
  }
}

function validateFilePath(path: string): void {
  if (!path || path === "." || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Provider credential file path is invalid: ${path}`);
  }
}

function isContainedBy(root: string, filePath: string): boolean {
  const path = relative(root, filePath);
  return path !== "" && !path.startsWith("..") && !path.includes("../");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
