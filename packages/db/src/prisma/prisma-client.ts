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
    const adapter = new PrismaPg({ connectionString: resolvePostgresDatabaseUrl() });
    sharedClient = new PrismaClient({ adapter });
  }
  return sharedClient;
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
