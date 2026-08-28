// mcp-catalog 域：MCP 目录项写入 / 读取 / release / 清单 / 删除。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "../database.ts";
import type {
  McpCatalogItemRecord,
  McpCatalogCategory,
  McpCatalogSource,
  McpRisk,
  McpTransport,
} from "../types.ts";
import {
  MCP_CATALOG_ITEM_FIELDS,
  MCP_CATALOG_ITEM_COLUMNS,
  mapMcpCatalogItemRecord,
} from "./mcp-center-internal.ts";

export interface UpsertMcpCatalogItemInput {
  id?: string;
  workspaceId?: string;
  source?: McpCatalogSource;
  slug: string;
  version?: string;
  category?: McpCatalogCategory;
  transport: McpTransport;
  displayName: string;
  description?: string;
  allowedHostsJson?: string;
  configurationSchemaJson?: string;
  declaredToolsJson?: string;
  defaultApprovedToolsJson?: string;
  secretFieldsJson?: string;
  requiredRuntimeCapabilitiesJson?: string;
  dataDomainsJson?: string;
  risk?: McpRisk;
  endpointTemplate?: string;
  documentationUrl?: string;
  requiredRuntimeAppJson?: string;
}

export function upsertMcpCatalogItemSync(input: UpsertMcpCatalogItemInput): McpCatalogItemRecord {
  return writeMcpCatalogItemSync(input, true);
}

/**
 * Creates a catalog row without allowing an existing slug to be overwritten.
 * Workspace catalog publication uses this path until releases are modeled as
 * distinct immutable rows.
 */
export function insertMcpCatalogItemSync(input: UpsertMcpCatalogItemInput): McpCatalogItemRecord {
  return writeMcpCatalogItemSync(input, false);
}

function writeMcpCatalogItemSync(input: UpsertMcpCatalogItemInput, allowOverwrite: boolean): McpCatalogItemRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const slug = input.slug.trim();
  if (!slug) {
    throw new Error("MCP catalog item slug is required.");
  }
  const id = input.id?.trim() || `mcp-cat-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO mcp_catalog_item (
        id,
        workspace_id,
        source,
        slug,
        version,
        category,
        transport,
        display_name,
        description,
        allowed_hosts_json,
        configuration_schema_json,
        declared_tools_json,
        default_approved_tools_json,
        secret_fields_json,
        required_runtime_capabilities_json,
        data_domains_json,
        risk,
        endpoint_template,
        documentation_url,
        required_runtime_app_json,
        synced_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${allowOverwrite ? `ON CONFLICT (workspace_id, slug, version) DO UPDATE SET
        source = excluded.source,
        category = excluded.category,
        transport = excluded.transport,
        display_name = excluded.display_name,
        description = excluded.description,
        allowed_hosts_json = excluded.allowed_hosts_json,
        configuration_schema_json = excluded.configuration_schema_json,
        declared_tools_json = excluded.declared_tools_json,
        default_approved_tools_json = excluded.default_approved_tools_json,
        secret_fields_json = excluded.secret_fields_json,
        required_runtime_capabilities_json = excluded.required_runtime_capabilities_json,
        data_domains_json = excluded.data_domains_json,
        risk = excluded.risk,
        endpoint_template = excluded.endpoint_template,
        documentation_url = excluded.documentation_url,
        required_runtime_app_json = excluded.required_runtime_app_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at` : ""}`,
    ).run(
      id,
      workspaceId,
      input.source ?? "workspace_private",
      slug,
      input.version?.trim() || "1.0.0",
      input.category ?? "other",
      input.transport,
      input.displayName.trim(),
      input.description?.trim() ?? "",
      input.allowedHostsJson ?? "[]",
      input.configurationSchemaJson ?? "{}",
      input.declaredToolsJson ?? "[]",
      input.defaultApprovedToolsJson ?? "[]",
      input.secretFieldsJson ?? "[]",
      input.requiredRuntimeCapabilitiesJson ?? "[]",
      input.dataDomainsJson ?? "[]",
      input.risk ?? "high",
      input.endpointTemplate?.trim() || null,
      input.documentationUrl?.trim() || null,
      input.requiredRuntimeAppJson ?? null,
      now,
      now,
      now,
    );
  });
  const record = readMcpCatalogItemReleaseSync(slug, input.version?.trim() || "1.0.0", workspaceId);
  if (!record) {
    throw new Error("Failed to persist MCP catalog item.");
  }
  return record;
}

export function readMcpCatalogItemSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): McpCatalogItemRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapMcpCatalogItemRecord(row) : null;
}

export function readMcpCatalogItemBySlugSync(slug: string, workspaceId = DEFAULT_WORKSPACE_ID): McpCatalogItemRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item
     WHERE workspace_id = ? AND slug = ?
     ORDER BY created_at DESC, version DESC LIMIT 1`,
  ).get(workspaceId, slug.trim()) as Record<string, unknown> | undefined;
  return row ? mapMcpCatalogItemRecord(row) : null;
}

export function readMcpCatalogItemReleaseSync(
  slug: string,
  version: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): McpCatalogItemRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item
     WHERE workspace_id = ? AND slug = ? AND version = ?`,
  ).get(workspaceId, slug.trim(), version.trim()) as Record<string, unknown> | undefined;
  return row ? mapMcpCatalogItemRecord(row) : null;
}

export function listMcpCatalogItemReleasesSync(
  slug: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): McpCatalogItemRecord[] {
  const rows = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item
     WHERE workspace_id = ? AND slug = ?
     ORDER BY created_at DESC, version DESC`,
  ).all(workspaceId, slug.trim()) as Array<Record<string, unknown>>;
  return rows.map(mapMcpCatalogItemRecord).filter((row): row is McpCatalogItemRecord => row !== null);
}

export function listMcpCatalogItemsSync(options: { workspaceId?: string; limit?: number } = {}): McpCatalogItemRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const rows = getDatabase().prepare(
    `SELECT * FROM (
       SELECT DISTINCT ON (slug) ${MCP_CATALOG_ITEM_FIELDS} FROM mcp_catalog_item
       WHERE workspace_id = ?
       ORDER BY slug, created_at DESC, version DESC
     ) latest
     ORDER BY "displayName" ASC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapMcpCatalogItemRecord).filter((r): r is McpCatalogItemRecord => r !== null);
}

export function deleteMcpCatalogItemSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const result = getDatabase().prepare(
    `DELETE FROM mcp_catalog_item WHERE id = ? AND workspace_id = ?`,
  ).run(id, workspaceId);
  return result.changes > 0;
}
