/**
 * Runtime credential vault.
 *
 * models.dofe.ai returns the plaintext RuntimeCredential API key exactly once
 * (on create/rotate). AgentSpace must hand it to the node-side mount (Phase 3)
 * without ever persisting plaintext to the database or logs. This abstraction
 * captures the plaintext behind an opaque `secretRef` that is safe to store.
 *
 * Phase 2 ships an in-memory default (sufficient to prove the pipeline; the
 * node-side mount that consumes the ref is Phase 3). Phase 3 swaps in a real
 * secret store (encrypted file the daemon reads, or a secrets manager).
 */

export interface RuntimeCredentialSecret {
  /** Opaque reference safe to persist on agent_runtime / provisioning task. */
  secretRef: string;
}

export interface RuntimeCredentialVault {
  /**
   * Store a plaintext key and return an opaque ref. Plaintext is kept only
   * inside the vault implementation.
   */
  store(credentialId: string, plaintextApiKey: string): RuntimeCredentialSecret;
  /** Retrieve the plaintext key for a ref, if still held. */
  retrieve(secretRef: string): string | undefined;
  /** Drop the plaintext for a ref (e.g. on revoke). */
  forget(secretRef: string): void;
}

class InMemoryRuntimeCredentialVault implements RuntimeCredentialVault {
  private readonly storeMap = new Map<string, string>();

  store(credentialId: string, plaintextApiKey: string): RuntimeCredentialSecret {
    const secretRef = `vault://runtime-credential/${credentialId}`;
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

let activeVault: RuntimeCredentialVault = new InMemoryRuntimeCredentialVault();

export function getRuntimeCredentialVault(): RuntimeCredentialVault {
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
