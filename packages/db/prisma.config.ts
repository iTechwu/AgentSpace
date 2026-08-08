// Prisma 7 configuration.
//
// In Prisma 7 the database connection URL moved out of schema.prisma and into
// this config file. `prisma generate` does not need a connection; `migrate` and
// `db pull` read `datasource.url` from here. The runtime PrismaClient instead
// receives the connection through the @prisma/adapter-pg adapter (see
// src/prisma/client.ts).
//
// Point DATABASE_URL at the desensitized test database for all local work:
//   DOFE_AGENT_TEST_DATABASE_URL (agent_space_test, schema v116)
import path from "node:path";
import { defineConfig } from "@prisma/config";

const url = process.env.DATABASE_URL ?? "";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  // Empty url lets `prisma generate` succeed offline; migrate/db pull require
  // DATABASE_URL to be set (they fail with a clear error otherwise).
  datasource: { url },
});
