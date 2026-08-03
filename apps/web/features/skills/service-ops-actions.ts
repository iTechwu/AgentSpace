"use server";

import {
  listManagedSkillServiceOperationsSync,
  listManagedSkillServicesSync,
  listSkillServiceBindingsForServiceSync,
  listSkillServiceCatalogSync,
  readAgentRuntimeSync,
} from "@dofe-agent/db";
import { queueManagedSkillServiceRetireSync } from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  infoToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

export interface SkillServiceOpsView {
  catalog: Array<{
    id: string;
    slug: string;
    templateVersion: string;
    deploymentType: string;
    imageDigest: string;
    signatureRequired: boolean;
    configSchemaVersion: number;
    risk?: string;
  }>;
  services: Array<{
    id: string;
    runtimeId: string;
    runtimeName: string;
    catalogSlug: string;
    catalogVersion: string;
    status: string;
    health?: string;
    unreferencedSince?: string;
    createdAt: string;
    bindingCount: number;
    operations: Array<{ id: string; operation: string; status: string; createdAt: string }>;
  }>;
}

/** 支撑服务运维视图（P1-3）：目录 + 受管实例（状态/健康/绑定/操作历史）。 */
export async function listSkillServiceOpsViewAction(): Promise<SkillServiceOpsView> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const workspaceId = workspaceContext.currentWorkspace.id;

  const catalogEntries = listSkillServiceCatalogSync(workspaceId);
  const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const services = listManagedSkillServicesSync(workspaceId).map((service) => {
    const catalog = catalogById.get(service.catalogId);
    const runtime = readAgentRuntimeSync(service.runtimeId);
    return {
      id: service.id,
      runtimeId: service.runtimeId,
      runtimeName: runtime?.name ?? service.runtimeId,
      catalogSlug: catalog?.slug ?? service.catalogId,
      catalogVersion: catalog?.templateVersion ?? "",
      status: service.status,
      health: service.lastHealth,
      unreferencedSince: service.unreferencedSince,
      createdAt: service.createdAt,
      bindingCount: listSkillServiceBindingsForServiceSync(service.id).length,
      operations: listManagedSkillServiceOperationsSync({
        workspaceId,
        serviceId: service.id,
        limit: 10,
      }).map((operation) => ({
        id: operation.id,
        operation: operation.operation,
        status: operation.status,
        createdAt: operation.createdAt,
      })),
    };
  });

  return {
    catalog: catalogEntries.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      templateVersion: entry.templateVersion,
      deploymentType: entry.deploymentType,
      imageDigest: entry.imageDigest,
      signatureRequired: entry.signatureRequired,
      configSchemaVersion: entry.configSchemaVersion,
      risk: typeof entry.risk === "string" ? entry.risk : undefined,
    })),
    services,
  };
}

export async function retireManagedSkillServiceAction(input: {
  serviceId: string;
}): Promise<ActionToastResult<{ queued: boolean; reason?: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const result = queueManagedSkillServiceRetireSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    serviceId: input.serviceId.trim(),
  });
  if (!result.queued) {
    return actionToastResult(
      { queued: false, reason: result.reason },
      infoToast("无法退役该服务。", "Could not retire the service."),
    );
  }
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/skills"]);
  return actionToastResult(
    { queued: true },
    infoToast("退役操作已入队。", "Retire operation queued."),
  );
}
