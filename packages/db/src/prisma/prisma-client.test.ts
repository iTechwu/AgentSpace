import assert from "node:assert/strict";
import test from "node:test";
import { listEmployeeRuntimeBindingsSync } from "../employee-bindings.ts";
import { listEmployeeRuntimeBindingsPrisma } from "./employees-runtime-bindings-prisma.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
} from "./prisma-client.ts";

test("shared Prisma client uses the PostgreSQL driver adapter", async () => {
  const client = getDofePrismaClient();
  const rows = await client.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`;

  assert.equal(Number(rows[0]?.value), 1);
  await disconnectDofePrismaClient();
});

test("employee runtime binding relation matches the legacy JOIN", async () => {
  const expected = listEmployeeRuntimeBindingsSync("default");
  const actual = await listEmployeeRuntimeBindingsPrisma("default");

  assert.deepEqual(actual, expected);
  await disconnectDofePrismaClient();
});
