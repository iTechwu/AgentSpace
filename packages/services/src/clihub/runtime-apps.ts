import {
  createRuntimeAppOperationSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  listDaemonSnapshotsSync,
  readAgentRuntimeSync,
  readRuntimeAppCatalogItemSync,
  readRuntimeInstalledAppSync,
  type RuntimeAppCatalogSource,
  type RuntimeAppOperationRecord,
  type RuntimeAppOperationType,
  type RuntimeInstalledAppRecord,
} from "@dofe-agent/db";
import type { RuntimeAppContextEntry, RuntimeAppInstallPlan } from "@dofe-agent/domain";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { assessRuntimeAppInstallability, buildRuntimeAppInstallPlan } from "./install-plan.ts";

export interface RuntimeAppOperationRequestResult {
  operation: RuntimeAppOperationRecord;
  installPlan: RuntimeAppInstallPlan;
}

export function assertCanManageRuntimeAppsSync(input: {
  workspaceId: string;
  actorUserId?: string;
}): void {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    throw new Error("Only workspace owners and admins can install, update, or uninstall runtime apps.");
  }
}

export function requestRuntimeAppOperationSync(input: {
  workspaceId: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  operation: RuntimeAppOperationType;
  actorUserId?: string;
  confirmHighRisk?: boolean;
}): RuntimeAppOperationRequestResult {
  assertCanManageRuntimeAppsSync({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
  });
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("runtime.not_found");
  }
  if (runtime.status !== "online") {
    throw new Error("runtime.offline");
  }
  const item = readRuntimeAppCatalogItemSync(input.source, input.name.trim());
  if (!item) {
    throw new Error("runtime_app.catalog_item_not_found");
  }
  const readiness = readCliHubReadinessForRuntimeSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeMetadataJson: runtime.metadataJson,
  });
  if (input.operation === "install" || input.operation === "update") {
    const installability = assessRuntimeAppInstallability(item, readiness);
    if (installability.status !== "installable") {
      throw new Error(installability.code ?? "runtime_app.not_installable");
    }
  }
  const installPlan = buildRuntimeAppInstallPlan({
    item,
    operation: input.operation,
    cliHubAvailable: readiness.cliHub.available,
  });
  if (installPlan.risk === "high" && input.confirmHighRisk !== true) {
    throw new Error("runtime_app.high_risk_confirmation_required");
  }
  const operation = createRuntimeAppOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    appSource: input.source,
    appName: item.name,
    operation: input.operation,
    requestedByUserId: input.actorUserId,
    commandPlanJson: JSON.stringify(installPlan),
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: `Runtime app ${input.operation} requested`,
    note: `${item.displayName} ${input.operation} was requested for runtime "${runtime.name}".`,
    code: `runtime_app.${input.operation}_requested`,
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "runtime_app",
      resourceId: `${item.source}:${item.name}`,
      runtimeId: runtime.id,
    },
  });
  return { operation, installPlan };
}

export function listRuntimeAppsForRuntimeSync(input: {
  workspaceId: string;
  runtimeId: string;
}): RuntimeInstalledAppRecord[] {
  return listRuntimeInstalledAppsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
  });
}

export function listRuntimeAppOperationsForRuntimeSync(input: {
  workspaceId: string;
  runtimeId: string;
  limit?: number;
}): RuntimeAppOperationRecord[] {
  return listRuntimeAppOperationsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    limit: input.limit,
  });
}

export function listRuntimeAppContextEntriesForRuntimeSync(input: {
  workspaceId: string;
  runtimeId: string;
}): RuntimeAppContextEntry[] {
  return listRuntimeInstalledAppsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    enabledOnly: true,
  }).map((installedApp) => {
    const catalogItem = readRuntimeAppCatalogItemSync(installedApp.source, installedApp.name);
    return {
      source: installedApp.source,
      name: installedApp.name,
      displayName: installedApp.displayName,
      version: installedApp.version || undefined,
      entryPoint: installedApp.entryPoint || undefined,
      skillMd: catalogItem?.skillMd,
      requiresText: catalogItem?.requiresText,
      category: catalogItem?.category,
    };
  });
}

export function readRuntimeAppAvailabilityForSkillSync(input: {
  workspaceId: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
}): "available" | "unavailable" {
  const app = readRuntimeInstalledAppSync(input);
  return app && app.status === "installed" && app.enabled ? "available" : "unavailable";
}

export interface CliHubReadinessView {
  checkedAt?: string;
  python: { available: boolean; version?: string; error?: string };
  pip: { available: boolean; version?: string; error?: string };
  cliHub: { available: boolean; version?: string; error?: string };
  npm: { available: boolean; version?: string; error?: string };
  uv: { available: boolean; version?: string; error?: string };
}

export function readCliHubReadinessFromRuntimeMetadata(metadataJson: string): CliHubReadinessView {
  try {
    const parsed = JSON.parse(metadataJson) as { cliHubReadiness?: unknown };
    return normalizeCliHubReadiness(parsed.cliHubReadiness);
  } catch {
    return normalizeCliHubReadiness(undefined);
  }
}

export function readCliHubReadinessForRuntimeSync(input: {
  workspaceId: string;
  runtimeId: string;
  runtimeMetadataJson?: string;
}): CliHubReadinessView {
  const daemonMetadataJson = listDaemonSnapshotsSync(input.workspaceId)
    .find((snapshot) => snapshot.runtimes.some((runtime) => runtime.id === input.runtimeId))
    ?.daemon.metadataJson;
  return selectCliHubReadiness(input.runtimeMetadataJson, daemonMetadataJson);
}

export function selectCliHubReadiness(
  runtimeMetadataJson?: string,
  daemonMetadataJson?: string,
): CliHubReadinessView {
  const fromRuntime = readCliHubReadinessFromRuntimeMetadata(runtimeMetadataJson ?? "{}");
  if (hasCliHubReadinessSignal(fromRuntime)) return fromRuntime;
  const fromDaemon = daemonMetadataJson ? readCliHubReadinessFromRuntimeMetadata(daemonMetadataJson) : undefined;
  return fromDaemon && hasCliHubReadinessSignal(fromDaemon) ? fromDaemon : fromRuntime;
}

export function normalizeCliHubReadiness(value: unknown): CliHubReadinessView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      python: { available: false, error: "Readiness check is missing." },
      pip: { available: false, error: "Readiness check is missing." },
      cliHub: { available: false, error: "Readiness check is missing." },
      npm: { available: false, error: "Readiness check is missing." },
      uv: { available: false, error: "Readiness check is missing." },
    };
  }
  const record = value as Record<string, unknown>;
  return {
    checkedAt: readOptionalString(record.checkedAt),
    python: readReadinessItem(record.python),
    pip: readReadinessItem(record.pip),
    cliHub: readReadinessItem(record.cliHub),
    npm: readReadinessItem(record.npm),
    uv: readReadinessItem(record.uv),
  };
}

function readReadinessItem(value: unknown): CliHubReadinessView["python"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { available: false, error: "Readiness check is missing." };
  }
  const record = value as Record<string, unknown>;
  return {
    available: record.available === true,
    version: readOptionalString(record.version),
    error: readOptionalString(record.error),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasCliHubReadinessSignal(readiness: CliHubReadinessView): boolean {
  return Boolean(
    readiness.checkedAt ||
    readiness.python.available ||
    readiness.pip.available ||
    readiness.cliHub.available ||
    readiness.npm.available ||
    readiness.uv.available ||
    readiness.python.error !== "Readiness check is missing." ||
    readiness.pip.error !== "Readiness check is missing." ||
    readiness.cliHub.error !== "Readiness check is missing." ||
    readiness.npm.error !== "Readiness check is missing." ||
    readiness.uv.error !== "Readiness check is missing.",
  );
}
