import { upsertSkillServiceCatalogSync } from "@dofe-agent/db";
import type { StoredSkillServiceCatalogRecord } from "@dofe-agent/db";

/**
 * Service catalog admission (05-运维服务与版本治理.md §准入检查 + CLAUDE.md):
 * a template may only enter the catalog when the image is digest-locked from an
 * approved registry, the rollback class and deployment type are known, the
 * network policy parses, and every external dependency references a
 * CENTRALLY-MANAGED service — templates must never create PostgreSQL, Redis or
 * RabbitMQ services, images, volumes or init jobs.
 */

const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ROLLBACK_CLASSES = new Set(["stateless", "backward_compatible", "irreversible_migration"]);

const DEPLOYMENT_TYPES = new Set(["external_connection", "managed_service", "platform_shared"]);

/** Data-store kinds that must never be created by a template (CLAUDE.md). */
const FORBIDDEN_CREATED_KINDS = new Set(["postgres", "postgresql", "redis", "rabbitmq", "rabbit"]);

export interface SkillServiceCatalogAdmissionInput {
  workspaceId?: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  templateDigest?: string;
  rollbackClass?: string;
  networkJson?: string;
  externalDependenciesJson?: string;
}

export type AdmissionResult = { ok: true } | { ok: false; reason: string };

/** Pure admission validation — returns a reason on failure, never throws. */
export function assertSkillServiceCatalogAdmissionSync(
  input: SkillServiceCatalogAdmissionInput,
): AdmissionResult {
  if (!input.slug.trim() || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug.trim())) {
    return { ok: false, reason: `Invalid catalog slug "${input.slug}".` };
  }
  if (!input.templateVersion.trim()) {
    return { ok: false, reason: "templateVersion is required." };
  }
  if (!DEPLOYMENT_TYPES.has(input.deploymentType)) {
    return {
      ok: false,
      reason: `Unknown deploymentType "${input.deploymentType}"; expected external_connection | managed_service | platform_shared.`,
    };
  }
  if (!IMAGE_DIGEST_PATTERN.test(input.imageDigest.trim().toLowerCase())) {
    return { ok: false, reason: `imageDigest must be digest-locked (sha256:<64 hex>), got "${input.imageDigest}".` };
  }
  if (input.rollbackClass && !ROLLBACK_CLASSES.has(input.rollbackClass)) {
    return {
      ok: false,
      reason: `Unknown rollbackClass "${input.rollbackClass}"; expected stateless | backward_compatible | irreversible_migration.`,
    };
  }
  if (!input.templateDigest?.trim()) {
    return { ok: false, reason: "templateDigest is required for an immutable template." };
  }

  const network = parseJsonObject(input.networkJson, "networkJson");
  if (!network.ok) {
    return network;
  }
  if (network.value && !Array.isArray(network.value.egressAllowlist)) {
    return { ok: false, reason: "networkJson must contain an egressAllowlist array." };
  }

  const deps = parseJsonArray(input.externalDependenciesJson, "externalDependenciesJson");
  if (!deps.ok) {
    return deps;
  }
  for (const dep of deps.value ?? []) {
    if (typeof dep !== "string") {
      return { ok: false, reason: "externalDependenciesJson entries must be strings of the form kind:name." };
    }
    const kind = dep.split(":")[0]?.trim().toLowerCase() ?? "";
    if (FORBIDDEN_CREATED_KINDS.has(kind)) {
      return {
        ok: false,
        reason: `External dependency "${dep}" would create a ${kind} service; only centrally-managed references are allowed (CLAUDE.md).`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validates admission then persists the catalog entry. `external_connection`
 * templates carry no image and are admitted with an empty (validated) digest.
 */
export function createSkillServiceCatalogEntrySync(
  input: SkillServiceCatalogAdmissionInput,
): StoredSkillServiceCatalogRecord {
  const admission = assertSkillServiceCatalogAdmissionSync(input);
  if (!admission.ok) {
    throw new Error(`skill_service_catalog.admission_failed: ${admission.reason}`);
  }
  return upsertSkillServiceCatalogSync({
    workspaceId: input.workspaceId,
    slug: input.slug.trim(),
    templateVersion: input.templateVersion.trim(),
    deploymentType: input.deploymentType,
    imageDigest: input.imageDigest.trim().toLowerCase(),
    rollbackClass: input.rollbackClass,
    networkJson: input.networkJson,
    externalDependenciesJson: input.externalDependenciesJson,
    templateDigest: input.templateDigest,
  });
}

function parseJsonObject(
  raw: string | undefined,
  label: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; reason: string } {
  if (!raw) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${label} must be a JSON object.` };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: `${label} is not valid JSON.` };
  }
}

function parseJsonArray(
  raw: string | undefined,
  label: string,
): { ok: true; value: unknown[] | undefined } | { ok: false; reason: string } {
  if (!raw) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: `${label} must be a JSON array.` };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: `${label} is not valid JSON.` };
  }
}
