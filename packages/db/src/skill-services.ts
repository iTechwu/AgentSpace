import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  StoredManagedSkillServiceRecord,
  StoredSkillServiceBindingRecord,
  StoredSkillServiceCatalogRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Skill Service Catalog (platform-reviewed templates)                 */
/* ------------------------------------------------------------------ */

export interface UpsertSkillServiceCatalogInput {
  workspaceId?: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  protocol?: string;
  scope?: string;
  resourcesJson?: string;
  healthJson?: string;
  networkJson?: string;
  configSchemaVersion?: number;
  configSchemaJson?: string;
  secretFieldsJson?: string;
  externalDependenciesJson?: string;
  rollbackClass?: string;
  templateDigest?: string;
  risk?: string;
}

const SKILL_SERVICE_CATALOG_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, slug, template_version AS templateVersion,
  deployment_type AS deploymentType, image_digest AS imageDigest, protocol, scope,
  resources_json AS resourcesJson, health_json AS healthJson, network_json AS networkJson,
  config_schema_version AS configSchemaVersion, config_schema_json AS configSchemaJson,
  secret_fields_json AS secretFieldsJson, external_dependencies_json AS externalDependenciesJson,
  rollback_class AS rollbackClass, template_digest AS templateDigest, risk,
  created_at AS createdAt, updated_at AS updatedAt`;

const MANAGED_SKILL_SERVICE_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId, catalog_id AS catalogId,
  status, network_identity AS networkIdentity, resource_profile_json AS resourceProfileJson,
  last_health AS lastHealth, last_health_at AS lastHealthAt,
  rollout_revision AS rolloutRevision, created_at AS createdAt, updated_at AS updatedAt`;

const SKILL_SERVICE_BINDING_COLUMNS = `SELECT
  installation_id AS installationId, service_id AS serviceId,
  catalog_template_version AS catalogTemplateVersion, service_image_digest AS serviceImageDigest,
  endpoint_ref AS endpointRef, health_revision AS healthRevision,
  config_schema_version AS configSchemaVersion, created_at AS createdAt`;

export function upsertSkillServiceCatalogSync(input: UpsertSkillServiceCatalogInput): StoredSkillServiceCatalogRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = readSkillServiceCatalogSync(input.slug, input.templateVersion, workspaceId);
  if (existing) {
    return existing;
  }
  const id = `svc-cat-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO skill_service_catalog (
        id, workspace_id, slug, template_version, deployment_type, image_digest, protocol, scope,
        resources_json, health_json, network_json, config_schema_version, config_schema_json,
        secret_fields_json, external_dependencies_json, rollback_class, template_digest, risk,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      input.slug,
      input.templateVersion,
      input.deploymentType,
      input.imageDigest,
      input.protocol ?? "http",
      input.scope ?? "workspace_runtime",
      input.resourcesJson ?? "{}",
      input.healthJson ?? "{}",
      input.networkJson ?? "{}",
      input.configSchemaVersion ?? 1,
      input.configSchemaJson ?? "{}",
      input.secretFieldsJson ?? "[]",
      input.externalDependenciesJson ?? "[]",
      input.rollbackClass ?? "stateless",
      input.templateDigest ?? "",
      input.risk ?? "high",
      now,
      now,
    );
  });
  const record = readSkillServiceCatalogSync(input.slug, input.templateVersion, workspaceId);
  if (!record) {
    throw new Error("Failed to persist skill service catalog entry.");
  }
  return record;
}

export function readSkillServiceCatalogSync(
  slug: string,
  templateVersion: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredSkillServiceCatalogRecord | null {
  const row = getDatabase().prepare(
    `${SKILL_SERVICE_CATALOG_COLUMNS} FROM skill_service_catalog
     WHERE workspace_id = ? AND slug = ? AND template_version = ?`,
  ).get(workspaceId, slug, templateVersion) as Record<string, unknown> | undefined;
  return row ? mapSkillServiceCatalogRecord(row) : null;
}

export function listSkillServiceCatalogSync(workspaceId = DEFAULT_WORKSPACE_ID): StoredSkillServiceCatalogRecord[] {
  const rows = getDatabase().prepare(
    `${SKILL_SERVICE_CATALOG_COLUMNS} FROM skill_service_catalog
     WHERE workspace_id = ? ORDER BY slug ASC, template_version ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillServiceCatalogRecord).filter((r): r is StoredSkillServiceCatalogRecord => r !== null);
}

/* ------------------------------------------------------------------ */
/* Managed service instances                                           */
/* ------------------------------------------------------------------ */

export interface UpsertManagedSkillServiceInput {
  workspaceId?: string;
  runtimeId: string;
  catalogId: string;
  status?: string;
  networkIdentity?: string;
  resourceProfileJson?: string;
  rolloutRevision?: string;
}

export function createManagedSkillServiceSync(input: UpsertManagedSkillServiceInput): StoredManagedSkillServiceRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = getDatabase().prepare(
    `${MANAGED_SKILL_SERVICE_COLUMNS} FROM managed_skill_service WHERE workspace_id = ? AND runtime_id = ? AND catalog_id = ?`,
  ).get(workspaceId, input.runtimeId, input.catalogId) as Record<string, unknown> | undefined;
  if (existing) {
    return mapManagedSkillServiceRecord(existing)!;
  }
  const id = `svc-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO managed_skill_service (
        id, workspace_id, runtime_id, catalog_id, status, network_identity, resource_profile_json,
        last_health, last_health_at, rollout_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      input.runtimeId,
      input.catalogId,
      input.status ?? "provisioning",
      input.networkIdentity ?? null,
      input.resourceProfileJson ?? "{}",
      input.rolloutRevision ?? "v1",
      now,
      now,
    );
  });
  const record = readManagedSkillServiceSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to persist managed skill service.");
  }
  return record;
}

export function readManagedSkillServiceSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredManagedSkillServiceRecord | null {
  const row = getDatabase().prepare(
    `${MANAGED_SKILL_SERVICE_COLUMNS} FROM managed_skill_service WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapManagedSkillServiceRecord(row) : null;
}

export function listManagedSkillServicesSync(workspaceId = DEFAULT_WORKSPACE_ID): StoredManagedSkillServiceRecord[] {
  const rows = getDatabase().prepare(
    `${MANAGED_SKILL_SERVICE_COLUMNS} FROM managed_skill_service WHERE workspace_id = ? ORDER BY created_at DESC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapManagedSkillServiceRecord).filter((r): r is StoredManagedSkillServiceRecord => r !== null);
}

export function setManagedSkillServiceHealthSync(input: {
  serviceId: string;
  workspaceId?: string;
  status: string;
  health?: string;
  lastHealthAt?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = db.prepare(
    `UPDATE managed_skill_service SET status = ?, last_health = ?, last_health_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(input.status, input.health ?? null, input.lastHealthAt ?? new Date().toISOString(), new Date().toISOString(), input.serviceId, workspaceId);
  return result.changes > 0;
}

/** Marks a managed service provisioned + healthy (provisioning → ready). */
export function completeManagedSkillServiceProvisioningSync(input: {
  serviceId: string;
  workspaceId?: string;
  health?: string;
}): boolean {
  return setManagedSkillServiceHealthSync({
    serviceId: input.serviceId,
    workspaceId: input.workspaceId,
    status: "ready",
    health: input.health ?? "healthy",
  });
}

/** Retires a managed service (ready/degraded → retired). */
export function retireManagedSkillServiceSync(input: {
  serviceId: string;
  workspaceId?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = db.prepare(
    `UPDATE managed_skill_service SET status = 'retired', updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('ready', 'degraded', 'provisioning')`,
  ).run(new Date().toISOString(), input.serviceId, workspaceId);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Bindings (installation × instance)                                  */
/* ------------------------------------------------------------------ */

export interface CreateSkillServiceBindingInput {
  installationId: string;
  serviceId: string;
  catalogTemplateVersion: string;
  serviceImageDigest: string;
  endpointRef: string;
  healthRevision?: string;
  configSchemaVersion?: number;
}

export function createSkillServiceBindingSync(input: CreateSkillServiceBindingInput): StoredSkillServiceBindingRecord {
  const now = new Date().toISOString();
  withTransaction(getDatabase(), () => {
    getDatabase().prepare(
      `INSERT INTO skill_service_binding (
        installation_id, service_id, catalog_template_version, service_image_digest,
        endpoint_ref, health_revision, config_schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (installation_id, service_id) DO UPDATE SET
        catalog_template_version = excluded.catalog_template_version,
        service_image_digest = excluded.service_image_digest,
        endpoint_ref = excluded.endpoint_ref,
        health_revision = excluded.health_revision,
        config_schema_version = excluded.config_schema_version`,
    ).run(
      input.installationId,
      input.serviceId,
      input.catalogTemplateVersion,
      input.serviceImageDigest,
      input.endpointRef,
      input.healthRevision ?? "",
      input.configSchemaVersion ?? 1,
      now,
    );
  });
  const row = getDatabase().prepare(
    `${SKILL_SERVICE_BINDING_COLUMNS} FROM skill_service_binding WHERE installation_id = ? AND service_id = ?`,
  ).get(input.installationId, input.serviceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Failed to persist skill service binding.");
  }
  return mapSkillServiceBindingRecord(row)!;
}

export function listSkillServiceBindingsSync(installationId: string): StoredSkillServiceBindingRecord[] {
  const rows = getDatabase().prepare(
    `${SKILL_SERVICE_BINDING_COLUMNS} FROM skill_service_binding WHERE installation_id = ? ORDER BY created_at DESC`,
  ).all(installationId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillServiceBindingRecord).filter((r): r is StoredSkillServiceBindingRecord => r !== null);
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function mapSkillServiceCatalogRecord(value: Record<string, unknown>): StoredSkillServiceCatalogRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.templateVersion !== "string" ||
    typeof value.deploymentType !== "string" ||
    typeof value.imageDigest !== "string" ||
    typeof value.protocol !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.configSchemaVersion !== "number" ||
    typeof value.resourcesJson !== "string" ||
    typeof value.healthJson !== "string" ||
    typeof value.networkJson !== "string" ||
    typeof value.configSchemaJson !== "string" ||
    typeof value.secretFieldsJson !== "string" ||
    typeof value.externalDependenciesJson !== "string" ||
    typeof value.rollbackClass !== "string" ||
    typeof value.templateDigest !== "string" ||
    typeof value.risk !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    slug: value.slug,
    templateVersion: value.templateVersion,
    deploymentType: value.deploymentType,
    imageDigest: value.imageDigest,
    protocol: value.protocol,
    scope: value.scope,
    resourcesJson: value.resourcesJson,
    healthJson: value.healthJson,
    networkJson: value.networkJson,
    configSchemaVersion: value.configSchemaVersion,
    configSchemaJson: value.configSchemaJson,
    secretFieldsJson: value.secretFieldsJson,
    externalDependenciesJson: value.externalDependenciesJson,
    rollbackClass: value.rollbackClass,
    templateDigest: value.templateDigest,
    risk: value.risk,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapManagedSkillServiceRecord(value: Record<string, unknown>): StoredManagedSkillServiceRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.catalogId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.resourceProfileJson !== "string" ||
    typeof value.rolloutRevision !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    catalogId: value.catalogId,
    status: value.status,
    networkIdentity: readOptionalString(value.networkIdentity),
    resourceProfileJson: value.resourceProfileJson,
    lastHealth: readOptionalString(value.lastHealth),
    lastHealthAt: readOptionalString(value.lastHealthAt),
    rolloutRevision: value.rolloutRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapSkillServiceBindingRecord(value: Record<string, unknown>): StoredSkillServiceBindingRecord | null {
  if (
    typeof value.installationId !== "string" ||
    typeof value.serviceId !== "string" ||
    typeof value.catalogTemplateVersion !== "string" ||
    typeof value.serviceImageDigest !== "string" ||
    typeof value.endpointRef !== "string" ||
    typeof value.healthRevision !== "string" ||
    typeof value.configSchemaVersion !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    installationId: value.installationId,
    serviceId: value.serviceId,
    catalogTemplateVersion: value.catalogTemplateVersion,
    serviceImageDigest: value.serviceImageDigest,
    endpointRef: value.endpointRef,
    healthRevision: value.healthRevision,
    configSchemaVersion: value.configSchemaVersion,
    createdAt: value.createdAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
