// Prisma client singleton — Phase 0 scaffolding.
//
// Route A: Prisma owns schema/migration governance. The legacy sync SQL layer
// (getDatabase/prepare) remains the runtime access path; this client is NOT yet
// wired into any repository. It is provided so the @prisma/adapter-pg lifecycle
// (connection, shutdown) can be exercised and so Phase 1+ repositories can adopt
// it incrementally. See docs/0808/db_migration_to_prisma/README.md.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

let client: PrismaClient | undefined;

/**
 * Returns a process-wide PrismaClient singleton backed by the @prisma/adapter-pg
 * driver adapter (reuses the existing `pg` connection semantics). Throws if
 * DATABASE_URL is unset.
 */
export function getPrismaClient(): PrismaClient {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to construct the Prisma client.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  client = new PrismaClient({ adapter });
  return client;
}

/** Disconnects and drops the singleton; for graceful shutdown and tests. */
export async function shutdownPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
}
