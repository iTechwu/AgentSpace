import {
  deleteWorkspaceServiceSecretSync as deleteDbWorkspaceServiceSecretSync,
  listSkillServiceCatalogSync,
  listWorkspaceServiceSecretsSync,
  upsertWorkspaceServiceSecretSync,
} from "@dofe-agent/db";
import { decryptServiceSecret, encryptServiceSecret } from "../mcp-center/security.ts";

const SECRET_FIELD_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Stores a secret VALUE for a service catalog template (the catalog's
 * `secretFieldsJson` declares the allowed names — a value can only be written
 * for a declared field). Encrypted at rest with the shared AES-256-GCM
 * envelope; the plaintext never leaves the control plane except to the managed
 * node at container-provision time (over the daemon's authenticated channel).
 */
export function setWorkspaceServiceSecretSync(input: {
  workspaceId?: string;
  serviceCatalogId: string;
  name: string;
  value: string;
}): { ok: true } | { ok: false; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  if (!SECRET_FIELD_PATTERN.test(input.name)) {
    return { ok: false, reason: `Invalid secret name "${input.name}"; expected an env-var name (e.g. RENDER_LICENSE).` };
  }
  const catalog = listSkillServiceCatalogSync(workspaceId).find((entry) => entry.id === input.serviceCatalogId);
  if (!catalog) {
    return { ok: false, reason: "Service catalog entry does not exist." };
  }
  const declared = parseSecretFields(catalog.secretFieldsJson);
  if (!declared.includes(input.name)) {
    return {
      ok: false,
      reason: `Secret "${input.name}" is not declared by catalog template "${catalog.slug}@${catalog.templateVersion}" (secretFieldsJson).`,
    };
  }
  const encryptedValue = encryptServiceSecret(input.value);
  upsertWorkspaceServiceSecretSync({ workspaceId, serviceCatalogId: input.serviceCatalogId, name: input.name, encryptedValue });
  return { ok: true };
}

/** Resolves the decrypted secret values for a service catalog (managed-node delivery). */
export function resolveWorkspaceServiceSecretsSync(input: {
  workspaceId?: string;
  serviceCatalogId: string;
}): Record<string, string> {
  const workspaceId = input.workspaceId ?? "default";
  const secrets: Record<string, string> = {};
  for (const record of listWorkspaceServiceSecretsSync(input.serviceCatalogId, workspaceId)) {
    try {
      secrets[record.name] = decryptServiceSecret(record.encryptedValue);
    } catch {
      // A corrupt/rotated-key entry is skipped; the container provision will
      // fail closed on a missing declared secret.
    }
  }
  return secrets;
}

export function deleteWorkspaceServiceSecretSync(input: {
  workspaceId?: string;
  serviceCatalogId: string;
  name: string;
}): boolean {
  return deleteDbWorkspaceServiceSecretSync({
    workspaceId: input.workspaceId,
    serviceCatalogId: input.serviceCatalogId,
    name: input.name,
  });
}

function parseSecretFields(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
