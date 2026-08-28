import { pathToFileURL } from "node:url";
import { createConnectorHttpServer, McpConnectorService } from "./server.ts";

export async function main(): Promise<void> {
  const service = new McpConnectorService({ timeoutMs: Number(process.env.MCP_CONNECTOR_TIMEOUT_MS ?? "120000") });
  const http = createConnectorHttpServer(service);
  const url = await http.start();
  console.log(`MCP connector listening on ${url}`);
  const shutdown = () => { void http.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });
