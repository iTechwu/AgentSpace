import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePrismaSchemaContract,
  parsePrismaSchemaContract,
} from "./schema-contract.ts";

test("Prisma schema contract captures mapped columns and composite primary keys", () => {
  const contract = parsePrismaSchemaContract(`
    model Binding {
      workspaceId String @map("workspace_id")
      employeeId String @map("employee_id")
      note String? @default("ready")
      runtime Runtime @relation(fields: [employeeId], references: [id])
      @@id([workspaceId, employeeId])
      @@map("employee_binding")
    }
    model Runtime {
      id String @id
      bindings Binding[]
      @@map("runtime")
    }
  `);

  assert.deepEqual(contract.models[0], {
    name: "Binding",
    tableName: "employee_binding",
    columns: [
      { fieldName: "workspaceId", columnName: "workspace_id", prismaType: "String", required: true, hasDefault: false, primary: true },
      { fieldName: "employeeId", columnName: "employee_id", prismaType: "String", required: true, hasDefault: false, primary: true },
      { fieldName: "note", columnName: "note", prismaType: "String", required: false, hasDefault: true, primary: false },
    ],
    indexes: [],
  });
});

test("Prisma schema contract captures field and composite unique/index declarations", () => {
  const contract = parsePrismaSchemaContract(`
    model Membership {
      id String @id
      workspaceId String @map("workspace_id")
      userId String @map("user_id") @unique
      slug String
      @@unique([workspaceId, slug])
      @@index([workspaceId, userId])
      @@map("membership")
    }
  `);
  assert.deepEqual(contract.models[0]?.indexes, [
    { columns: ["user_id"], unique: true },
    { columns: ["workspace_id", "slug"], unique: true },
    { columns: ["workspace_id", "user_id"], unique: false },
  ]);
});

test("schema comparison reports type, nullability, default, and primary-key drift", () => {
  const contract = parsePrismaSchemaContract(`
    model Audit {
      id String @id
      createdAt DateTime @map("created_at") @db.Timestamptz(6)
      data Json @default("{}")
      @@map("audit_log")
    }
  `);
  const drift = comparePrismaSchemaContract(contract, {
    columns: [
      { tableName: "audit_log", columnName: "id", dataType: "text", nullable: false, hasDefault: false },
      { tableName: "audit_log", columnName: "created_at", dataType: "timestamp without time zone", nullable: true, hasDefault: false },
      { tableName: "audit_log", columnName: "data", dataType: "text", nullable: false, hasDefault: false },
    ],
    primaryKeys: new Map([["audit_log", []]]),
    indexes: [],
  });

  assert.deepEqual(drift, [
    "audit_log.created_at: expected timestamp with time zone, received timestamp without time zone",
    "audit_log.created_at: expected NOT NULL",
    "audit_log.data: expected jsonb, received text",
    "audit_log.data: expected a database default",
    "audit_log: expected primary key (id), received ()",
  ]);
});

test("schema comparison reports missing unique and regular indexes", () => {
  const contract = parsePrismaSchemaContract(`
    model Membership {
      id String @id
      workspaceId String @map("workspace_id")
      userId String @map("user_id")
      @@unique([workspaceId, userId])
      @@map("membership")
    }
  `);
  const drift = comparePrismaSchemaContract(contract, {
    columns: [
      { tableName: "membership", columnName: "id", dataType: "text", nullable: false, hasDefault: false },
      { tableName: "membership", columnName: "workspace_id", dataType: "text", nullable: false, hasDefault: false },
      { tableName: "membership", columnName: "user_id", dataType: "text", nullable: false, hasDefault: false },
    ],
    primaryKeys: new Map([["membership", ["id"]]]),
    indexes: [],
  });
  assert.deepEqual(drift, ["membership: missing unique:workspace_id,user_id"]);
});
