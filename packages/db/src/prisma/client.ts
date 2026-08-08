// Prisma client singleton — Phase 2 runtime access layer.
//
// Route A/B: Prisma owns schema/migration governance (Phase 1) and is now being
// adopted incrementally as an async runtime access layer alongside the legacy
// sync SQL layer (Phase 2). The two coexist on ONE database during the
// dual-track period, so this client MUST resolve the same connection URL the
// legacy `getDatabase()` sync layer uses. See docs/0808/db_migration_to_prisma/README.md.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";

let client: PrismaClient | undefined;

/**
 * Returns a process-wide PrismaClient singleton backed by the @prisma/adapter-pg
 * driver adapter. The connection URL is resolved via `resolvePostgresDatabaseUrl`
 * (SELF_HOSTED_DATABASE_URL > DOFE_AGENT_PG_URL > DATABASE_URL; test-aware so the
 * test process targets agent_space_test) — the SAME resolver and precedence the
 * legacy sync `getDatabase()` layer uses. This guarantees the async Prisma repos
 * and the sync repos hit the identical database (load-bearing for Phase 2 parity
 * and the dual-track coexistence). Throws if no URL is resolvable.
 */
export function getPrismaClient(): PrismaClient {
  if (client) return client;
  const connectionString = resolvePostgresDatabaseUrl();
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
