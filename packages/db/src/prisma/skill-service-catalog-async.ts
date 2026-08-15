// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 skill-service-catalog-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { StoredSkillServiceCatalogRecord } from "../types.ts";

export async function listSkillServiceCatalogAsync(
  workspaceId: string = "default",
): Promise<StoredSkillServiceCatalogRecord[]> {
  const sql = `SELECT id, workspace_id, slug, template_version, deployment_type,
                     image_digest, protocol, scope, resources_json, health_json,
                     network_json, config_schema_version, config_schema_json,
                     secret_fields_json, external_dependencies_json,
                     rollback_class, template_digest, sbom_digest,
                     run_as_non_root, read_only_rootfs, cap_drop_json,
                     signature_key_pem, content_hash, published_by,
                     published_at, created_at
              FROM skill_service_catalog
              WHERE workspace_id = $1
              ORDER BY slug ASC, template_version ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isSkillServiceCatalogAsyncReadEnabled(): boolean {
  return process.env.SKILL_SERVICE_CATALOG_ASYNC_READ_ENABLED === "1";
}

export function isSkillServiceCatalogShadowReadEnabled(): boolean {
  return process.env.SKILL_SERVICE_CATALOG_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  slug: string;
  template_version: string;
  deployment_type: string;
  image_digest: string;
  protocol: string;
  scope: string;
  resources_json: string;
  health_json: string;
  network_json: string;
  config_schema_version: number;
  config_schema_json: string;
  secret_fields_json: string;
  external_dependencies_json: string;
  rollback_class: string;
  template_digest: string;
  sbom_digest: string | null;
  run_as_non_root: boolean;
  read_only_rootfs: boolean;
  cap_drop_json: string;
  signature_key_pem: string | null;
  signature_required: boolean;
  risk: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): StoredSkillServiceCatalogRecord {
  const record: StoredSkillServiceCatalogRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    templateVersion: row.template_version,
    deploymentType: row.deployment_type,
    imageDigest: row.image_digest,
    protocol: row.protocol,
    scope: row.scope,
    resourcesJson: row.resources_json,
    healthJson: row.health_json,
    networkJson: row.network_json,
    configSchemaVersion: row.config_schema_version,
    configSchemaJson: row.config_schema_json,
    secretFieldsJson: row.secret_fields_json,
    externalDependenciesJson: row.external_dependencies_json,
    rollbackClass: row.rollback_class,
    templateDigest: row.template_digest,
    runAsNonRoot: row.run_as_non_root,
    readOnlyRootfs: row.read_only_rootfs,
    capDropJson: row.cap_drop_json,
    signatureRequired: row.signature_required,
    risk: row.risk,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.sbom_digest !== null) record.sbomDigest = row.sbom_digest;
  if (row.signature_key_pem !== null) record.signatureKeyPem = row.signature_key_pem;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}