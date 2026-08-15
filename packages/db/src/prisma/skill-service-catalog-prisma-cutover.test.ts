// Unit tests for the skill-service-catalog Prisma Client cutover runner
// (Phase 2 13 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSkillServiceCatalogRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listSkillServiceCatalogPrismaCutover,
  type ListSkillServiceCatalogPrismaCutoverMetric,
} from "./skill-service-catalog-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED;
  delete process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED;
  else process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED;
  else process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaCatalog {
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

interface MockPrismaClient {
  skillServiceCatalog: {
    findMany: (args: unknown) => Promise<MockPrismaCatalog[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaCatalog[]>,
): MockPrismaClient {
  return { skillServiceCatalog: { findMany: behavior } };
}

function toPrismaRow(record: StoredSkillServiceCatalogRecord): MockPrismaCatalog {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    slug: record.slug,
    templateVersion: record.templateVersion,
    deploymentType: record.deploymentType,
    imageDigest: record.imageDigest,
    protocol: record.protocol,
    scope: record.scope,
    resourcesJson: record.resourcesJson,
    healthJson: record.healthJson,
    networkJson: record.networkJson,
    configSchemaVersion: record.configSchemaVersion,
    configSchemaJson: record.configSchemaJson,
    secretFieldsJson: record.secretFieldsJson,
    externalDependenciesJson: record.externalDependenciesJson,
    rollbackClass: record.rollbackClass,
    templateDigest: record.templateDigest,
    sbomDigest: record.sbomDigest ?? null,
    runAsNonRoot: record.runAsNonRoot,
    readOnlyRootfs: record.readOnlyRootfs,
    capDropJson: record.capDropJson,
    signatureKeyPem: record.signatureKeyPem ?? null,
    signatureRequired: record.signatureRequired,
    risk: record.risk,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listSkillServiceCatalogPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListSkillServiceCatalogPrismaCutoverMetric[] = [];
  const result = await listSkillServiceCatalogPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listSkillServiceCatalogPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED = "1";
  delete process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredSkillServiceCatalogRecord = {
    id: "ssc-prisma-mock",
    workspaceId: "default",
    slug: "mock-skill",
    templateVersion: "v1",
    deploymentType: "container",
    imageDigest: "sha256:0000",
    protocol: "stdio",
    scope: "workspace",
    resourcesJson: "{}",
    healthJson: "{}",
    networkJson: "{}",
    configSchemaVersion: 1,
    configSchemaJson: "{}",
    secretFieldsJson: "[]",
    externalDependenciesJson: "[]",
    rollbackClass: "restart",
    templateDigest: "sha256:1111",
    runAsNonRoot: true,
    readOnlyRootfs: true,
    capDropJson: "[]",
    signatureRequired: false,
    risk: "low",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListSkillServiceCatalogPrismaCutoverMetric[] = [];
  const result = await listSkillServiceCatalogPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "ssc-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listSkillServiceCatalogPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED = "1";
  delete process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma skill service catalog unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListSkillServiceCatalogPrismaCutoverMetric[] = [];
  const result = await listSkillServiceCatalogPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});