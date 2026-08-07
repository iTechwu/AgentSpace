"use server";

import type { McpCatalogCategory, McpRisk, McpTransport, RuntimeAppCatalogSource } from "@dofe-agent/db";
import {
  createMcpCatalogItemSync,
  disableMcpConnectionSync,
  enableMcpConnectionSync,
  removeMcpConnectionSync,
  removeMcpConnectionAsync,
  type McpRemovalStrategy,
  replaceMcpConnectionConfigSync,
  requestMcpConnectionSync,
  reverifyMcpConnectionSync,
  rotateMcpSecretSync,
  updateMcpConnectionConfigServiceSync,
  type McpDeclaredTool,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

export interface CreateMcpCatalogItemActionInput {
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

export async function createMcpCatalogItemAction(
  input: CreateMcpCatalogItemActionInput,
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createMcpCatalogItemSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    ...input,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market"]);
  return actionToastResult(undefined, successToast("MCP 服务已添加到目录。", "MCP service added to the catalog."));
}

export interface RequestMcpConnectionActionInput {
  runtimeId: string;
  catalogItemId: string;
  endpoint: string;
  nonSecretParams?: Record<string, unknown>;
  secrets?: Record<string, string>;
  approvedTools?: string[];
  confirmHighRisk?: boolean;
}

export async function requestMcpConnectionAction(
  input: RequestMcpConnectionActionInput,
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  requestMcpConnectionSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    runtimeId: input.runtimeId.trim(),
    catalogItemId: input.catalogItemId,
    endpoint: input.endpoint.trim(),
    nonSecretParams: input.nonSecretParams,
    secrets: input.secrets,
    approvedTools: input.approvedTools,
    confirmHighRisk: input.confirmHighRisk,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("MCP 连接已创建，正在验证。", "MCP connection created; verifying."));
}

export interface UpdateMcpConnectionConfigActionInput {
  connectionId: string;
  endpoint?: string;
  nonSecretParams?: Record<string, unknown>;
  approvedTools?: string[];
  confirmHighRisk?: boolean;
}

export async function updateMcpConnectionConfigAction(
  input: UpdateMcpConnectionConfigActionInput,
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateMcpConnectionConfigServiceSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
    endpoint: input.endpoint?.trim(),
    nonSecretParams: input.nonSecretParams,
    approvedTools: input.approvedTools,
    confirmHighRisk: input.confirmHighRisk,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("配置已更新，需要重新验证。", "Configuration updated; re-verification required."));
}

export interface ReplaceMcpConnectionConfigActionInput {
  connectionId: string;
  endpoint?: string;
  nonSecretParams?: Record<string, unknown>;
  approvedTools?: string[];
  /** Plaintext secrets to rotate; omitted fields keep their stored value. */
  secrets?: Record<string, string>;
  confirmHighRisk?: boolean;
}

/** Atomic replacement of config + secrets in a single transaction with one reverify + one audit. */
export async function replaceMcpConnectionConfigAction(
  input: ReplaceMcpConnectionConfigActionInput,
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  replaceMcpConnectionConfigSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
    endpoint: input.endpoint?.trim(),
    nonSecretParams: input.nonSecretParams,
    approvedTools: input.approvedTools,
    secrets: input.secrets,
    confirmHighRisk: input.confirmHighRisk,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("配置与密钥已原子更新，需要重新验证。", "Configuration and secrets updated atomically; re-verification required."));
}

export async function rotateMcpSecretAction(input: {
  connectionId: string;
  fieldName: string;
  value: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  rotateMcpSecretSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
    fieldName: input.fieldName,
    value: input.value,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("密钥已轮换，需要重新验证。", "Secret rotated; re-verification required."));
}

export async function reverifyMcpConnectionAction(input: { connectionId: string }): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  reverifyMcpConnectionSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("已发起重新验证。", "Re-verification requested."));
}

export async function disableMcpConnectionAction(input: { connectionId: string }): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  disableMcpConnectionSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("连接已停用。", "Connection disabled."));
}

export async function enableMcpConnectionAction(input: { connectionId: string }): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  enableMcpConnectionSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("连接正在重新验证后启用。", "Connection re-verifying before enable."));
}

export async function removeMcpConnectionAction(input: {
  connectionId: string;
  strategy?: McpRemovalStrategy;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const result = await removeMcpConnectionAsync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    connectionId: input.connectionId,
    strategy: input.strategy,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/market/mcp-connections", "/agents", "/runtimes"]);
  return actionToastResult(
    undefined,
    result.status === "queued"
      ? successToast("连接移除已排队。", "Connection removal queued.")
      : successToast("连接已停用，等待运行中 Job 完成结算后移除。", "Connection disabled; removal waits for running Jobs and billing reconciliation."),
  );
}
