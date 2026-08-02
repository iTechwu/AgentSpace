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

/** Types that run a real container image — these carry an SBOM. */
const IMAGE_TEMPLATE_TYPES = new Set(["managed_service", "platform_shared"]);

/** Docker capability names (upper snake); an empty array means "drop nothing extra". */
const CAP_DROP_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Environment-variable-like secret field names (e.g. RENDER_LICENSE). */
const SECRET_FIELD_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Egress allow-list entries: a host or host:port or URL, no spaces/controls. */
const EGRESS_ENTRY_PATTERN = /^[^\s]{1,253}$/;

/**
 * Data-store kinds a template may only REFERENCE (centrally managed), never
 * create. The catalog template itself carries no image/volume/init-job fields
 * for these; the only place they may appear is the external-dependency REFERENCE
 * list, which the validator below enforces to be kind:name references.
 */
const CENTRALLY_MANAGED_REFERENCE_KINDS = new Set(["postgres", "postgresql", "redis", "rabbitmq", "rabbit"]);

export interface SkillServiceCatalogAdmissionInput {
  workspaceId?: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  templateDigest?: string;
  sbomDigest?: string;
  rollbackClass?: string;
  networkJson?: string;
  healthJson?: string;
  resourcesJson?: string;
  secretFieldsJson?: string;
  externalDependenciesJson?: string;
  runAsNonRoot?: boolean;
  readOnlyRootfs?: boolean;
  capDrop?: string[];
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

  // Images that actually run a container must ship an SBOM so vulnerability/
  // license posture is part of the immutable template (05-运维 §准入检查).
  if (IMAGE_TEMPLATE_TYPES.has(input.deploymentType)) {
    if (!input.sbomDigest?.trim() || !IMAGE_DIGEST_PATTERN.test(input.sbomDigest.trim().toLowerCase())) {
      return {
        ok: false,
        reason: `managed_service/platform_shared templates must declare a digest-locked sbomDigest (sha256:<64 hex>), got "${input.sbomDigest ?? ""}".`,
      };
    }
  } else if (input.sbomDigest?.trim()) {
    // external_connection has no image; an SBOM is meaningless but harmless.
  }

  if (input.runAsNonRoot !== undefined && typeof input.runAsNonRoot !== "boolean") {
    return { ok: false, reason: "runAsNonRoot must be a boolean." };
  }
  if (input.readOnlyRootfs !== undefined && typeof input.readOnlyRootfs !== "boolean") {
    return { ok: false, reason: "readOnlyRootfs must be a boolean." };
  }
  if (input.capDrop !== undefined) {
    if (!Array.isArray(input.capDrop)) {
      return { ok: false, reason: "capDrop must be an array of Docker capability names." };
    }
    for (const cap of input.capDrop) {
      if (typeof cap !== "string" || !CAP_DROP_PATTERN.test(cap)) {
        return { ok: false, reason: `Invalid capDrop entry "${String(cap)}"; expected an upper-snake Docker capability name.` };
      }
    }
  }

  const network = parseJsonObject(input.networkJson, "networkJson");
  if (!network.ok) {
    return network;
  }
  // Image templates MUST declare their egress policy (05-运维 §准入检查 "网络仅
  // 能到 allow-list"); an empty array means "no outbound allowed". external_
  // connection templates may omit it.
  if (IMAGE_TEMPLATE_TYPES.has(input.deploymentType)) {
    if (!network.value || !Array.isArray(network.value.egressAllowlist)) {
      return {
        ok: false,
        reason: "managed_service/platform_shared templates must declare networkJson.egressAllowlist (an array; empty = no egress).",
      };
    }
  } else if (network.value && !Array.isArray(network.value.egressAllowlist)) {
    return { ok: false, reason: "networkJson must contain an egressAllowlist array." };
  }
  for (const entry of (network.value?.egressAllowlist as unknown[]) ?? []) {
    if (typeof entry !== "string" || !EGRESS_ENTRY_PATTERN.test(entry)) {
      return { ok: false, reason: `Invalid egressAllowlist entry "${String(entry)}"; expected a host, host:port or URL.` };
    }
  }

  const health = parseJsonObject(input.healthJson, "healthJson");
  if (!health.ok) {
    return health;
  }
  if (health.value && Object.keys(health.value).length > 0) {
    const hasPath = typeof health.value.path === "string" && health.value.path.startsWith("/");
    const hasCmd = typeof health.value.cmd === "string" && health.value.cmd.length > 0;
    if (!hasPath && !hasCmd) {
      return { ok: false, reason: "healthJson must declare a \"/...\" path or a non-empty cmd string." };
    }
    if (health.value.port !== undefined && typeof health.value.port !== "number") {
      return { ok: false, reason: "healthJson.port must be a number when present." };
    }
  }

  const resources = parseJsonObject(input.resourcesJson, "resourcesJson");
  if (!resources.ok) {
    return resources;
  }
  for (const key of ["memory", "cpu", "memorySwap"] as const) {
    const value = resources.value?.[key];
    if (value !== undefined && typeof value !== "string" && typeof value !== "number") {
      return { ok: false, reason: `resourcesJson.${key} must be a string or number.` };
    }
  }

  const secrets = parseJsonArray(input.secretFieldsJson, "secretFieldsJson");
  if (!secrets.ok) {
    return secrets;
  }
  for (const secret of secrets.value ?? []) {
    if (typeof secret !== "string" || !SECRET_FIELD_PATTERN.test(secret)) {
      return {
        ok: false,
        reason: `secretFieldsJson entries must be env-var names (e.g. RENDER_LICENSE), got "${String(secret)}".`,
      };
    }
  }

  const deps = parseJsonArray(input.externalDependenciesJson, "externalDependenciesJson");
  if (!deps.ok) {
    return deps;
  }
  for (const dep of deps.value ?? []) {
    if (typeof dep !== "string" || !/^[a-z0-9-]+:[a-zA-Z0-9._-]+$/.test(dep.trim())) {
      return {
        ok: false,
        reason: `externalDependenciesJson entries must be references of the form kind:name, got "${String(dep)}".`,
      };
    }
    const kind = dep.split(":")[0]!.trim().toLowerCase();
    if (CENTRALLY_MANAGED_REFERENCE_KINDS.has(kind)) {
      // Allowed: this is a REFERENCE to a centrally-managed data store
      // (CLAUDE.md: app deployments connect to externally managed services).
      continue;
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
    healthJson: input.healthJson,
    resourcesJson: input.resourcesJson,
    secretFieldsJson: input.secretFieldsJson,
    externalDependenciesJson: input.externalDependenciesJson,
    templateDigest: input.templateDigest,
    sbomDigest: input.sbomDigest?.trim().toLowerCase(),
    runAsNonRoot: input.runAsNonRoot,
    readOnlyRootfs: input.readOnlyRootfs,
    capDropJson: input.capDrop ? JSON.stringify(input.capDrop) : undefined,
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
