import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";

let sharedClient: PrismaClient | null = null;
let injectedClient: PrismaClient | null = null;

export function getDofePrismaClient(): PrismaClient {
  if (injectedClient) {
    return injectedClient;
  }
  if (!sharedClient) {
    const adapter = new PrismaPg({
      connectionString: withUtcSessionTimezone(resolvePostgresDatabaseUrl()),
    });
    sharedClient = new PrismaClient({ adapter });
  }
  return sharedClient;
}

function withUtcSessionTimezone(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const existingOptions = parsed.searchParams.get("options")?.trim();
  parsed.searchParams.set(
    "options",
    [existingOptions, "-c timezone=UTC"].filter(Boolean).join(" "),
  );
  return parsed.toString();
}

export function setDofePrismaClientForTests(client: PrismaClient | null): void {
  injectedClient = client;
}

export async function disconnectDofePrismaClient(): Promise<void> {
  injectedClient = null;
  const client = sharedClient;
  sharedClient = null;
  if (client) {
    await client.$disconnect();
  }
}
