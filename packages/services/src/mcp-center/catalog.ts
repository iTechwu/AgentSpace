import {
  deleteMcpCatalogItemSync,
  insertMcpCatalogItemSync,
  listMcpConnectionsSync,
  listMcpCatalogItemsSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemReleaseSync,
  readMcpCatalogItemSync,
  readWorkspaceRuntimeAppReleaseSync,
  type McpCatalogItemRecord,
  type McpCatalogCategory,
  type McpRisk,
  type McpTransport,
  type RuntimeAppCatalogSource,
} from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { validateManagedStdioEndpoint } from "./security.ts";

export interface McpDeclaredTool {
  name: string;
  description: string;
  risk: McpRisk;
}

export interface CreateMcpCatalogItemInput {
  workspaceId: string;
  actorUserId?: string;
  slug: string;
  displayName: string;
  description?: string;
  version?: string;
  category?: McpCatalogCategory;
  transport: McpTransport;
  allowedHosts: string[];
  configurationSchema: Record<string, unknown>;
  declaredTools: McpDeclaredTool[];
  defaultApprovedTools?: string[];
  secretFields?: string[];
  requiredRuntimeCapabilities?: string[];
  dataDomains?: string[];
  risk?: McpRisk;
  endpointTemplate?: string;
  documentationUrl?: string;
  requiredRuntimeApp?: {
    source: RuntimeAppCatalogSource;
    name: string;
    version: string;
  };
}

export function assertCanManageMcpCenterSync(input: { workspaceId: string; actorUserId?: string }): void {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    throw new Error("Only workspace owners and admins can manage MCP center resources.");
  }
}

const VALID_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$/;

export function createMcpCatalogItemSync(input: CreateMcpCatalogItemInput): McpCatalogItemRecord {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });

  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9\-]{0,62}$/.test(slug)) {
    throw new Error("mcp_catalog.invalid_slug");
  }
  if (slug.startsWith("official-")) {
    throw new Error("mcp_catalog.reserved_slug");
  }
  const version = input.version?.trim() || "1.0.0";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("mcp_catalog.invalid_version");
  }
  if (readMcpCatalogItemReleaseSync(slug, version, input.workspaceId)) {
    throw new Error("mcp_catalog.release_exists");
  }
  if (!input.displayName.trim()) {
    throw new Error("mcp_catalog.invalid_display_name");
  }
  if (input.transport !== "streamable_http" && input.transport !== "managed_stdio") {
    throw new Error("mcp_catalog.unsupported_transport");
  }
  const allowedHosts = (input.allowedHosts ?? []).map((h) => h.trim()).filter(Boolean);
  if (input.transport === "streamable_http" && allowedHosts.length === 0) {
    throw new Error("mcp_catalog.allowed_hosts_required");
  }
  for (const host of allowedHosts) {
    if (!isValidHostRule(host)) {
      throw new Error("mcp_catalog.invalid_allowed_host");
    }
  }
  const configurationSchema = normalizeConfigurationSchema(input.configurationSchema);
  const declaredTools = (input.declaredTools ?? []).filter(Boolean);
  if (declaredTools.length === 0) {
    throw new Error("mcp_catalog.declared_tools_required");
  }
  const normalizedToolNames = new Set<string>();
  for (const tool of declaredTools) {
    const name = tool.name?.trim();
    if (!name || !VALID_TOOL_NAME.test(name)) {
      throw new Error("mcp_catalog.invalid_tool_name");
    }
    if (normalizedToolNames.has(name)) {
      throw new Error("mcp_catalog.duplicate_tool_name");
    }
    normalizedToolNames.add(name);
    if (!tool.description?.trim()) {
      throw new Error("mcp_catalog.tool_description_required");
    }
  }
  const defaultApproved = (input.defaultApprovedTools ?? []).map((t) => t.trim()).filter(Boolean);
  for (const name of defaultApproved) {
    if (!normalizedToolNames.has(name)) {
      throw new Error("mcp_catalog.default_tool_not_declared");
    }
  }
  const secretFields = (input.secretFields ?? []).map((s) => s.trim()).filter(Boolean);
  if (input.transport === "managed_stdio") {
    const endpointTemplate = input.endpointTemplate?.trim();
    if (!endpointTemplate || !validateManagedStdioEndpoint(endpointTemplate).ok) {
      throw new Error("mcp_catalog.invalid_managed_stdio_endpoint");
    }
    const schemaProperties = configurationSchema.properties && typeof configurationSchema.properties === "object"
      ? Object.keys(configurationSchema.properties as Record<string, unknown>)
      : [];
    if ([...schemaProperties, ...secretFields].some((name) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || ["HOME", "PATH"].includes(name) || name.startsWith("DOFE_"))) {
      throw new Error("mcp_catalog.invalid_managed_stdio_environment");
    }
    const requirement = input.requiredRuntimeApp;
    if (!requirement || requirement.source !== "workspace_private") {
      throw new Error("mcp_catalog.required_runtime_app_required");
    }
    const release = readWorkspaceRuntimeAppReleaseSync(requirement.name.trim(), input.workspaceId);
    if (!release || release.yankedAt || release.version !== requirement.version.trim()) {
      throw new Error("mcp_catalog.required_runtime_app_not_found");
    }
    if (endpointTemplate !== `stdio://${release.entryPoint}`) {
      throw new Error("mcp_catalog.required_runtime_app_entrypoint_mismatch");
    }
  } else if (input.requiredRuntimeApp) {
    throw new Error("mcp_catalog.required_runtime_app_not_supported");
  }

  // Workspace-created catalog entries have not passed platform review, so they
  // always retain high-risk treatment irrespective of a caller-provided label.
  const risk: McpRisk = "high";
  let record: McpCatalogItemRecord;
  try {
    record = insertMcpCatalogItemSync({
      workspaceId: input.workspaceId,
      source: "workspace_private",
      slug,
      version,
      category: input.category ?? "other",
      transport: input.transport,
      displayName: input.displayName.trim(),
      description: input.description?.trim(),
      allowedHostsJson: JSON.stringify(allowedHosts),
      configurationSchemaJson: JSON.stringify(configurationSchema),
      declaredToolsJson: JSON.stringify(declaredTools),
      defaultApprovedToolsJson: JSON.stringify(defaultApproved),
      secretFieldsJson: JSON.stringify(secretFields),
      requiredRuntimeCapabilitiesJson: JSON.stringify(input.requiredRuntimeCapabilities ?? []),
      dataDomainsJson: JSON.stringify(input.dataDomains ?? []),
      risk,
      endpointTemplate: input.endpointTemplate?.trim() || undefined,
      documentationUrl: input.documentationUrl?.trim() || undefined,
      requiredRuntimeAppJson: input.requiredRuntimeApp ? JSON.stringify(input.requiredRuntimeApp) : undefined,
    });
  } catch (error) {
    if (isMcpCatalogSlugConflict(error)) {
      throw new Error("mcp_catalog.release_exists");
    }
    throw error;
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP catalog item created",
    note: `Catalog item "${record.displayName}" (${record.slug}) was published to the MCP center.`,
    code: "mcp_catalog.created",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_catalog_item",
      resourceId: record.id,
      transport: record.transport,
      risk: record.risk,
      requiredRuntimeAppSource: record.requiredRuntimeApp?.source,
      requiredRuntimeAppName: record.requiredRuntimeApp?.name,
      requiredRuntimeAppVersion: record.requiredRuntimeApp?.version,
    },
  });

  return record;
}

function isMcpCatalogSlugConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate/i.test(message) && /mcp_catalog_item|workspace_id.*slug|slug.*workspace_id/i.test(message);
}

function normalizeConfigurationSchema(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.type !== "object") {
    throw new Error("mcp_catalog.invalid_configuration_schema");
  }
  if (input.additionalProperties !== undefined && input.additionalProperties !== false) {
    throw new Error("mcp_catalog.configuration_schema_must_forbid_additional_properties");
  }
  if (input.patternProperties !== undefined) {
    throw new Error("mcp_catalog.configuration_schema_pattern_properties_not_supported");
  }
  const rawProperties = input.properties ?? {};
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    throw new Error("mcp_catalog.invalid_configuration_schema");
  }
  const properties = rawProperties as Record<string, unknown>;
  if (Object.keys(properties).length > 32) {
    throw new Error("mcp_catalog.configuration_schema_too_many_fields");
  }
  for (const [name, definition] of Object.entries(properties)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) {
      throw new Error("mcp_catalog.invalid_configuration_field");
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error("mcp_catalog.invalid_configuration_field");
    }
    const field = definition as Record<string, unknown>;
    if (field.type !== "string" || (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || Number(field.maxLength) > 4096))) {
      throw new Error("mcp_catalog.invalid_configuration_field");
    }
  }
  const required = input.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !(name in properties))) {
    throw new Error("mcp_catalog.invalid_configuration_schema");
  }
  return { ...input, properties, required, additionalProperties: false };
}

export function listMcpCatalogItemsForWorkspaceSync(workspaceId: string): McpCatalogItemRecord[] {
  return listMcpCatalogItemsSync({ workspaceId });
}

export function readMcpCatalogItemForWorkspaceSync(input: {
  workspaceId: string;
  catalogItemId?: string;
  slug?: string;
}): McpCatalogItemRecord | null {
  if (input.catalogItemId) {
    return readMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  }
  if (input.slug) {
    return readMcpCatalogItemBySlugSync(input.slug, input.workspaceId);
  }
  return null;
}

export function deleteMcpCatalogItemForWorkspaceSync(input: {
  workspaceId: string;
  catalogItemId: string;
  actorUserId?: string;
}): void {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const existing = readMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  if (!existing) {
    throw new Error("mcp_catalog.not_found");
  }
  if (existing.source !== "workspace_private") {
    throw new Error("mcp_catalog.system_release_read_only");
  }
  const connections = listMcpConnectionsSync({ workspaceId: input.workspaceId, limit: 500 });
  if (connections.some((c) => c.catalogItemId === input.catalogItemId)) {
    throw new Error("mcp_catalog.in_use");
  }
  deleteMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP catalog item removed",
    note: `Catalog item "${existing.displayName}" (${existing.slug}) was removed from the MCP center.`,
    code: "mcp_catalog.removed",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_catalog_item",
      resourceId: existing.id,
    },
  });
}

function isValidHostRule(rule: string): boolean {
  if (!rule) return false;
  // Allow exact hosts or wildcard/suffix rules.
  if (rule.startsWith("*.")) {
    return isValidHostRule(rule.slice(2));
  }
  if (rule.startsWith(".")) {
    return isValidHostRule(rule.slice(1));
  }
  return /^[a-z0-9]([a-z0-9\-_.]*[a-z0-9])?$/i.test(rule) && rule.includes(".");
}
