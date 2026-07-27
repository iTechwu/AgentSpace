/**
 * Runtime credential vault.
 *
 * models.dofe.ai returns the plaintext RuntimeCredential API key exactly once
 * (on create/rotate). AgentSpace must hand it to the node-side mount (Phase 3)
 * without ever persisting plaintext to the database or logs. This abstraction
 * captures the plaintext behind an opaque `secretRef` that is safe to store.
 *
 * Production uses an encrypted, durable file vault. Tests can explicitly
 * install the in-memory implementation through resetRuntimeCredentialVaultForTests.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimeCredentialSecret {
  /** Opaque reference safe to persist on agent_runtime / provisioning task. */
  secretRef: string;
}

export interface RuntimeCredentialScope {
  tenantId: string;
  teamId: string;
  runtimeId: string;
}

export interface RuntimeCredentialVault {
  /**
   * Store a plaintext key and return an opaque ref. Plaintext is kept only
   * inside the vault implementation.
   */
  store(credentialId: string, plaintextApiKey: string, scope?: RuntimeCredentialScope): RuntimeCredentialSecret;
  /** Retrieve the plaintext key for a ref, if still held. */
  retrieve(secretRef: string, scope?: RuntimeCredentialScope): string | undefined;
  /** Drop the plaintext for a ref (e.g. on revoke). */
  forget(secretRef: string, scope?: RuntimeCredentialScope): void;
}

class InMemoryRuntimeCredentialVault implements RuntimeCredentialVault {
  private readonly storeMap = new Map<string, string>();

  store(credentialId: string, plaintextApiKey: string, scope?: RuntimeCredentialScope): RuntimeCredentialSecret {
    const secretRef = buildRuntimeCredentialSecretRef(credentialId, scope);
    this.storeMap.set(secretRef, plaintextApiKey);
    return { secretRef };
  }

  retrieve(secretRef: string): string | undefined {
    return this.storeMap.get(secretRef);
  }

  forget(secretRef: string): void {
    this.storeMap.delete(secretRef);
  }
}

interface StoredRuntimeCredential {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
  scope?: RuntimeCredentialScope;
}

/**
 * A durable vault for a single AgentSpace control-plane instance. The master
 * key is supplied by deployment configuration, never generated at runtime.
 */
export class EncryptedFileRuntimeCredentialVault implements RuntimeCredentialVault {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(
    directory: string,
    key: Buffer,
  ) {
    if (key.length !== 32) {
      throw new Error("DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }
    this.directory = directory;
    this.key = key;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  store(credentialId: string, plaintextApiKey: string, scope?: RuntimeCredentialScope): RuntimeCredentialSecret {
    const secretRef = buildRuntimeCredentialSecretRef(credentialId, scope);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextApiKey, "utf8"), cipher.final()]);
    const document: StoredRuntimeCredential = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      scope,
    };
    const destination = this.pathFor(secretRef);
    const pending = `${destination}.next-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(pending, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
    chmodSync(pending, 0o600);
    renameSync(pending, destination);
    return { secretRef };
  }

  retrieve(secretRef: string, scope?: RuntimeCredentialScope): string | undefined {
    const filePath = this.pathFor(secretRef);
    if (!existsSync(filePath)) return undefined;
    const document = parseStoredRuntimeCredential(readFileSync(filePath, "utf8"));
    if (!document || !scopesMatch(document.scope, scope)) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(document.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(document.tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(document.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return undefined;
    }
  }

  forget(secretRef: string, scope?: RuntimeCredentialScope): void {
    const filePath = this.pathFor(secretRef);
    if (!existsSync(filePath)) return;
    const document = parseStoredRuntimeCredential(readFileSync(filePath, "utf8"));
    if (!document || !scopesMatch(document.scope, scope)) return;
    rmSync(filePath, { force: true });
  }

  private pathFor(secretRef: string): string {
    return join(this.directory, `${createHash("sha256").update(secretRef, "utf8").digest("hex")}.json`);
  }
}

let activeVault: RuntimeCredentialVault | undefined;

export function getRuntimeCredentialVault(): RuntimeCredentialVault {
  activeVault ??= createRuntimeCredentialVaultFromEnvironment();
  return activeVault;
}

/** Swap the vault implementation (Phase 3 wires a real secret store here). */
export function setRuntimeCredentialVault(vault: RuntimeCredentialVault): void {
  activeVault = vault;
}

/** For tests: reset to the default in-memory vault. */
export function resetRuntimeCredentialVaultForTests(): void {
  activeVault = new InMemoryRuntimeCredentialVault();
}

export function createRuntimeCredentialVaultFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeCredentialVault {
  const encodedKey = environment.DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY?.trim()
    || environment.AGENT_SPACE_RUNTIME_CREDENTIAL_ENCRYPTION_KEY?.trim();
  const directory = environment.DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR?.trim()
    || environment.AGENT_SPACE_RUNTIME_CREDENTIAL_VAULT_DIR?.trim();
  if (!encodedKey || !directory) {
    throw new Error("DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY and DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR are required for managed runtimes.");
  }
  return new EncryptedFileRuntimeCredentialVault(resolve(directory), Buffer.from(encodedKey, "base64"));
}

function buildRuntimeCredentialSecretRef(credentialId: string, scope?: RuntimeCredentialScope): string {
  if (!scope) return `vault://runtime-credential/${credentialId}`;
  return [
    "vault://runtime-credential",
    encodeURIComponent(scope.tenantId),
    encodeURIComponent(scope.teamId),
    encodeURIComponent(scope.runtimeId),
    encodeURIComponent(credentialId),
  ].join("/");
}

function parseStoredRuntimeCredential(value: string): StoredRuntimeCredential | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StoredRuntimeCredential>;
    if (
      parsed.version !== 1 ||
      typeof parsed.iv !== "string" ||
      typeof parsed.tag !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      (parsed.scope !== undefined && !isRuntimeCredentialScope(parsed.scope))
    ) {
      return undefined;
    }
    return parsed as StoredRuntimeCredential;
  } catch {
    return undefined;
  }
}

function scopesMatch(stored: RuntimeCredentialScope | undefined, expected: RuntimeCredentialScope | undefined): boolean {
  if (!stored || !expected) return stored === expected;
  return stored.tenantId === expected.tenantId
    && stored.teamId === expected.teamId
    && stored.runtimeId === expected.runtimeId;
}

function isRuntimeCredentialScope(value: unknown): value is RuntimeCredentialScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return typeof scope.tenantId === "string"
    && typeof scope.teamId === "string"
    && typeof scope.runtimeId === "string";
}
