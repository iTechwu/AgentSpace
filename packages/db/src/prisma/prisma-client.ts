import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";

let sharedClient: PrismaClient | null = null;
let injectedClient: PrismaClient | null = null;

type PrismaShutdownEvent = "beforeExit" | "SIGINT" | "SIGTERM";

export interface PrismaShutdownSignalSource {
  once(event: PrismaShutdownEvent, listener: () => void): unknown;
  off(event: PrismaShutdownEvent, listener: () => void): unknown;
}

export interface RegisterDofePrismaShutdownHooksOptions {
  signalSource?: PrismaShutdownSignalSource;
  disconnect?: () => Promise<void>;
  onError?: (error: unknown) => void;
}

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

export function registerDofePrismaShutdownHooks(
  options: RegisterDofePrismaShutdownHooksOptions = {},
): () => void {
  const signalSource = options.signalSource ?? process;
  const disconnect = options.disconnect ?? disconnectDofePrismaClient;
  const onError = options.onError ?? ((error: unknown) => {
    console.error("Failed to disconnect Prisma Client during shutdown.", error);
  });
  let closing = false;
  const events: PrismaShutdownEvent[] = ["beforeExit", "SIGINT", "SIGTERM"];
  const unregister = (): void => {
    for (const event of events) {
      signalSource.off(event, close);
    }
  };
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    unregister();
    void disconnect().catch(onError);
  };
  for (const event of events) {
    signalSource.once(event, close);
  }
  return unregister;
}
