// skill-service-catalog Phase 2 真 Prisma Client primary：与前 12 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { StoredSkillServiceCatalogRecord } from "../types.ts";

interface PrismaSkillServiceCatalog {
  id: string;
  workspaceId: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  protocol: string;
  scope: string;
  resourcesJson: string;
  healthJson: string;
  networkJson: string;
  configSchemaVersion: number;
  configSchemaJson: string;
  secretFieldsJson: string;
  externalDependenciesJson: string;
  rollbackClass: string;
  templateDigest: string;
  sbomDigest: string | null;
  runAsNonRoot: boolean;
  readOnlyRootfs: boolean;
  capDropJson: string;
  signatureKeyPem: string | null;
  signatureRequired: boolean;
  risk: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listSkillServiceCatalogPrisma(
  workspaceId: string = "default",
  client?: PrismaClient,
): Promise<StoredSkillServiceCatalogRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.skillServiceCatalog.findMany({
    where: { workspaceId },
    orderBy: [{ slug: "asc" }, { templateVersion: "asc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaSkillServiceCatalog));
}

export function isSkillServiceCatalogPrismaReadEnabled(): boolean {
  return process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED === "1";
}

export function isSkillServiceCatalogPrismaShadowReadEnabled(): boolean {
  return process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setSkillServiceCatalogPrismaClientForTests };

export async function disconnectSkillServiceCatalogPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaSkillServiceCatalog,
): StoredSkillServiceCatalogRecord {
  const record: StoredSkillServiceCatalogRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    templateVersion: row.templateVersion,
    deploymentType: row.deploymentType,
    imageDigest: row.imageDigest,
    protocol: row.protocol,
    scope: row.scope,
    resourcesJson: row.resourcesJson,
    healthJson: row.healthJson,
    networkJson: row.networkJson,
    configSchemaVersion: row.configSchemaVersion,
    configSchemaJson: row.configSchemaJson,
    secretFieldsJson: row.secretFieldsJson,
    externalDependenciesJson: row.externalDependenciesJson,
    rollbackClass: row.rollbackClass,
    templateDigest: row.templateDigest,
    runAsNonRoot: row.runAsNonRoot,
    readOnlyRootfs: row.readOnlyRootfs,
    capDropJson: row.capDropJson,
    signatureRequired: row.signatureRequired,
    risk: row.risk,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.sbomDigest !== null) record.sbomDigest = row.sbomDigest;
  if (row.signatureKeyPem !== null) record.signatureKeyPem = row.signatureKeyPem;
  return record;
}